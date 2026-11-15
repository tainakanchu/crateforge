//! 一覧の「表示順の track_id 列」のプロセス内キャッシュ (`docs/library-list/design.md` §3)。
//!
//! デスクトップの一覧は、件数 → 見えているページ → (必要なら) 全 ID 列、と同じ一覧を何度も引く。
//! 並べ替え (NATSORT) とスマートプレイリストの評価はライブラリ全体を走査するので、呼び出しごとに
//! やり直すと 1 ページ取るたびに全件ぶんのコストがかかる。そこで、一覧ごとの ID 列を覚えておき、
//! ページ・件数・ID 列はそこから切り出す。
//!
//! 無効化: どのコネクションでも書き込みトランザクションがコミットされるたびにリビジョンを進める
//! (`Database::open` が commit hook を張る)。リビジョンが違うエントリは使わない。
//! - commit hook はコミットの直前に呼ばれるので、その直後に計算した結果はコミット前の内容かも
//!   しれない。コミットから [`SETTLE`] 以内に計算した結果は覚えない。
//! - 時間で結果が変わる条件 (「最近追加した曲」など) があるので、[`TTL`] を過ぎたエントリも使わない。
//! - DB ファイルを差し替える操作 (復元) は [`invalidate`] を呼ぶ。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 覚えておく一覧の数 (1 件あたり最大でも「曲数 × 8 バイト」)。
const MAX_ENTRIES: usize = 8;
/// エントリの寿命。
const TTL: Duration = Duration::from_secs(60);
/// コミットの直後、結果を覚えない時間。
const SETTLE: Duration = Duration::from_millis(250);

static REVISION: AtomicU64 = AtomicU64::new(0);

struct Entry {
    key: String,
    revision: u64,
    stored_at: Instant,
    ids: Arc<Vec<i64>>,
}

#[derive(Default)]
struct State {
    /// 新しい順。
    entries: VecDeque<Entry>,
    last_commit: Option<Instant>,
}

/// ライブラリが書き換わった (書き込みトランザクションのコミット)。以後、古いエントリは使わない。
pub(crate) fn invalidate() {
    REVISION.fetch_add(1, Ordering::SeqCst);
    with_state(|s| s.last_commit = Some(Instant::now()));
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    static STATE: Mutex<Option<State>> = Mutex::new(None);
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// `key` の ID 列を返す。有効なエントリがあればそれを、無ければ `compute` して覚える。
/// `key` は DB (scope) と一覧 (スコープ・検索語・並び順) を一意に表す文字列。
pub(crate) fn get_or_compute(
    key: String,
    compute: impl FnOnce() -> rusqlite::Result<Vec<i64>>,
) -> rusqlite::Result<Arc<Vec<i64>>> {
    let revision = REVISION.load(Ordering::SeqCst);
    let hit = with_state(|s| {
        let now = Instant::now();
        s.entries
            .retain(|e| e.revision == revision && now.duration_since(e.stored_at) < TTL);
        let pos = s.entries.iter().position(|e| e.key == key)?;
        let entry = s.entries.remove(pos)?;
        let ids = entry.ids.clone();
        s.entries.push_front(entry);
        Some(ids)
    });
    if let Some(ids) = hit {
        return Ok(ids);
    }
    let ids = Arc::new(compute()?);
    with_state(|s| {
        let now = Instant::now();
        let settling = s
            .last_commit
            .is_some_and(|at| now.duration_since(at) < SETTLE);
        // 計算中にコミットがあった / コミットの直後なら、内容が古いかもしれないので覚えない。
        if settling || REVISION.load(Ordering::SeqCst) != revision {
            return;
        }
        s.entries.push_front(Entry {
            key,
            revision,
            stored_at: now,
            ids: ids.clone(),
        });
        s.entries.truncate(MAX_ENTRIES);
    });
    Ok(ids)
}

/// `ids` の 1 ページぶん (offset から limit 件)。範囲外は空。
pub(crate) fn page(ids: &[i64], limit: i64, offset: i64) -> &[i64] {
    let start = (offset.max(0) as usize).min(ids.len());
    let end = start.saturating_add(limit.max(0) as usize).min(ids.len());
    &ids[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn compute_counted(calls: &Cell<u32>, ids: Vec<i64>) -> impl FnOnce() -> rusqlite::Result<Vec<i64>> + '_ {
        move || {
            calls.set(calls.get() + 1);
            Ok(ids)
        }
    }

    /// ほかのテスト (別スレッド) の書き込みでもリビジョンが進むので、「2 回目は計算しない」は
    /// 何度か試して 1 回でも成立すればよい、という形で確かめる。
    #[test]
    fn caches_until_invalidated() {
        let key = || "test:caches_until_invalidated".to_string();
        let mut hit = false;
        for _ in 0..50 {
            std::thread::sleep(SETTLE + Duration::from_millis(30));
            let calls = Cell::new(0);
            let a = get_or_compute(key(), compute_counted(&calls, vec![3, 1, 2])).unwrap();
            let b = get_or_compute(key(), compute_counted(&calls, vec![9, 9, 9])).unwrap();
            assert_eq!(*a, vec![3, 1, 2]);
            if calls.get() == 1 {
                assert_eq!(*b, vec![3, 1, 2], "2 回目は覚えた列を返す");
                hit = true;
                break;
            }
        }
        assert!(hit, "キャッシュが一度も効かなかった");

        // 書き込みがあったら、覚えた列は使わない。
        invalidate();
        let calls = Cell::new(0);
        let c = get_or_compute(key(), compute_counted(&calls, vec![7])).unwrap();
        assert_eq!((*c).clone(), vec![7]);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn page_slices_and_clamps() {
        let ids = [1, 2, 3, 4, 5];
        assert_eq!(page(&ids, 2, 0), &[1, 2]);
        assert_eq!(page(&ids, 2, 4), &[5]);
        assert_eq!(page(&ids, 2, 9), &[] as &[i64]);
        assert_eq!(page(&ids, i64::MAX, 1), &[2, 3, 4, 5]);
        assert_eq!(page(&ids, -1, -1), &[] as &[i64]);
    }
}
