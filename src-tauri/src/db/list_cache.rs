//! 一覧の「表示順の track_id 列」のプロセス内キャッシュ (`docs/library-list/design.md` §3.1)。
//!
//! デスクトップの一覧は、件数 → 見えているページ → (必要なら) 全 ID 列、と同じ一覧を何度も引く。
//! 並べ替え (NATSORT) とスマートプレイリストの評価はライブラリ全体を走査するので、呼び出しごとに
//! やり直すと 1 ページ取るたびに全件ぶんのコストがかかる。そこで、一覧ごとの ID 列を覚えておき、
//! ページ・件数・ID 列はそこから切り出す。
//!
//! # 覚えた列を使ってよい条件
//!
//! DB ごと ([`Scope`]) に 3 つの値を見る。
//!
//! - **一覧リビジョン** (`relevant`): このプロセスの書き込みトランザクションのうち、一覧に関係する
//!   テーブルを触ったものがコミットされるたびに進める (commit hook + update hook)。
//!   再生位置の保存 (`app_state` / `play_queue` / `playback_state`) のような一覧に関係しない
//!   書き込みでは進めないので、再生中に 5 秒ごとにキャッシュが消えることはない。
//! - **data_version**: 監視用の常駐コネクションで読む `PRAGMA data_version`。ほかのコネクション
//!   (このプロセスの書き込み・別プロセス) のコミットが **完了** すると変わる。
//! - **コミット数** (`commits`): このプロセスのコミット (一覧に関係しないものも含む) の回数。
//!
//! 覚えるとき: 計算の前後で一覧リビジョンと data_version が変わっていなければ覚える
//! (変わっていたら、計算の途中で書き込みが入っている)。
//!
//! 使うとき: 一覧リビジョンが同じで、かつ
//! - data_version も同じなら使う (計算してから何もコミットされていない)。
//! - data_version が違っても、その間にこのプロセスのコミットがあったなら (一覧リビジョンは同じなので、
//!   どれも一覧に関係しない書き込み) 使う。ただし下の「確定前」のエントリは除く。
//! - data_version が違い、このプロセスのコミットも無い → 別プロセスが書いたので使わない。
//!
//! commit hook は **コミットの直前** に呼ばれる。一覧リビジョンを進めた直後に計算を始めると、
//! まだコミットされていない (古い) 内容を読んで、新しいリビジョンとして覚えてしまう。
//! そこで、一覧に関係するコミットの直後 ([`SETTLE`] 以内) に計算を **始めた** エントリは
//! 「確定前」とし、data_version が同じあいだだけ使う (そのコミットが完了すれば data_version が
//! 変わるので、古い内容なら必ず捨てられる)。監視用コネクションが無い DB (テスト用のインメモリ)
//! では確かめようがないので、その時間に始めた計算は覚えない。
//!
//! ほかに、時間で結果が変わる条件 (「最近追加した曲」など) があるので [`TTL`] を過ぎたら使わず、
//! DB ファイルを差し替える操作 (復元) は [`invalidate`] を呼ぶ。同じ一覧を同時に計算しない
//! (後から来た呼び出しは先の計算を待って、その結果を使う)。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 覚えておく一覧の数 (DB ごと。1 件あたり最大でも「曲数 × 8 バイト」)。
const MAX_ENTRIES: usize = 12;
/// エントリの寿命。
const TTL: Duration = Duration::from_secs(60);
/// 一覧に関係するコミットの直後、計算結果を「確定前」として扱う時間。
const SETTLE: Duration = Duration::from_millis(250);

/// 触っても一覧 (並び・検索・スマートプレイリストの評価) が変わらないテーブル。
/// `app_state` の設定のうち一覧に効くもの (検索の字体ゆれ吸収レベル) は、一覧のキーに含める。
const IRRELEVANT_TABLES: [&str; 7] = [
    "app_state",
    "play_queue",
    "playback_state",
    "recent_tracks",
    "sync_selection",
    "sync_source",
    "sync_track",
];

/// このテーブルへの書き込みで一覧が変わりうるか。
pub(crate) fn is_relevant_table(table: &str) -> bool {
    !IRRELEVANT_TABLES.contains(&table)
}

/// 計算を始める前に読んだ値。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Stamp {
    relevant: u64,
    commits: u64,
    data_version: Option<i64>,
    /// 一覧に関係するコミットの直後に始めた (内容が古いかもしれない)。
    unsettled: bool,
}

struct Entry {
    key: String,
    stamp: Stamp,
    stored_at: Instant,
    ids: Arc<Vec<i64>>,
}

/// 1 つの DB のキャッシュ。時刻と data_version は引数で受ける (テストで決められるように)。
#[derive(Default)]
pub(crate) struct Scope {
    relevant: u64,
    commits: u64,
    last_relevant_commit: Option<Instant>,
    /// 新しい順。
    entries: VecDeque<Entry>,
}

impl Scope {
    /// トランザクションのコミット (commit hook)。`relevant` は一覧に関係する書き込みを含むか。
    pub(crate) fn committed(&mut self, relevant: bool, now: Instant) {
        self.commits += 1;
        if relevant {
            self.relevant += 1;
            self.last_relevant_commit = Some(now);
        }
    }

    /// 全部捨てる (DB ファイルの差し替えなど、コミットを経ない変更)。
    pub(crate) fn invalidate(&mut self, now: Instant) {
        self.committed(true, now);
        self.entries.clear();
    }

    /// 計算を始める前の値。
    pub(crate) fn stamp(&self, data_version: Option<i64>, now: Instant) -> Stamp {
        Stamp {
            relevant: self.relevant,
            commits: self.commits,
            data_version,
            unsettled: self
                .last_relevant_commit
                .is_some_and(|at| now.duration_since(at) < SETTLE),
        }
    }

    /// 覚えている列 (使ってよいものだけ)。
    pub(crate) fn lookup(
        &mut self,
        key: &str,
        data_version: Option<i64>,
        now: Instant,
    ) -> Option<Arc<Vec<i64>>> {
        let (relevant, commits) = (self.relevant, self.commits);
        self.entries.retain(|e| {
            e.stamp.relevant == relevant
                && now.duration_since(e.stored_at) < TTL
                && (e.stamp.data_version == data_version
                    // data_version が変わったのがこのプロセスの (一覧に関係しない) コミットのせいなら使える。
                    // 確定前のエントリは、古い内容かもしれないので data_version が同じあいだだけ。
                    || (!e.stamp.unsettled && e.stamp.commits != commits))
        });
        let pos = self.entries.iter().position(|e| e.key == key)?;
        let entry = self.entries.remove(pos)?;
        let ids = entry.ids.clone();
        self.entries.push_front(entry);
        Some(ids)
    }

    /// 計算結果を覚える。`before` は計算を始める前の [`Self::stamp`]、`data_version_after` は
    /// 計算のあとに読んだ data_version。途中で書き込みが入っていたら覚えない (false)。
    pub(crate) fn store(
        &mut self,
        key: String,
        ids: Arc<Vec<i64>>,
        before: Stamp,
        data_version_after: Option<i64>,
        now: Instant,
    ) -> bool {
        if before.relevant != self.relevant || before.data_version != data_version_after {
            return false;
        }
        // data_version で確かめられない DB では、コミットの直後に始めた計算は覚えない。
        if before.unsettled && before.data_version.is_none() {
            return false;
        }
        self.entries.retain(|e| e.key != key);
        self.entries.push_front(Entry {
            key,
            // その後のコミット数で「一覧に関係しないコミットがあったか」を見るので、覚えた時点の値にする。
            stamp: Stamp {
                commits: self.commits,
                ..before
            },
            stored_at: now,
            ids,
        });
        self.entries.truncate(MAX_ENTRIES);
        true
    }

    /// テスト用: 直前のコミットから十分に時間がたったことにする。
    #[cfg(test)]
    pub(crate) fn settle(&mut self) {
        self.last_relevant_commit = None;
    }
}

/// DB (scope 名) ごとの状態と、同じ一覧の計算を 1 つにまとめるためのロック。
#[derive(Default)]
struct Shared {
    scope: Mutex<Scope>,
    /// 一覧のキー → 計算中のロック。
    computing: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// data_version を読むための常駐コネクション (ファイルの DB だけ)。
    monitor: Mutex<Monitor>,
}

#[derive(Default)]
struct Monitor {
    path: Option<std::path::PathBuf>,
    conn: Option<rusqlite::Connection>,
}

impl Monitor {
    /// ほかのコネクションのコミットが完了すると変わる値。読めなければ None。
    fn data_version(&mut self) -> Option<i64> {
        if self.conn.is_none() {
            // 開けなくても動く (data_version で確かめられないだけ)。
            self.conn = rusqlite::Connection::open_with_flags(
                self.path.as_ref()?,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .ok();
        }
        self.conn
            .as_ref()?
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .ok()
    }
}

/// DB ファイルを差し替える前後に呼ぶ: 覚えた列を全部捨て、監視用コネクションを閉じる
/// (開いたままだと、Windows ではファイルを置き換えられない)。次に使うとき開き直す。
pub(crate) fn release(scope: &str) {
    let shared = shared(scope);
    lock(&shared.scope).invalidate(Instant::now());
    lock(&shared.monitor).conn = None;
}

fn shared(scope: &str) -> Arc<Shared> {
    static ALL: OnceLock<Mutex<HashMap<String, Arc<Shared>>>> = OnceLock::new();
    ALL.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(scope.to_string())
        .or_default()
        .clone()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// DB への 1 コネクションぶんのハンドル。[`crate::db::Database`] が持つ。
pub(crate) struct Handle {
    shared: Arc<Shared>,
    /// API からの問い合わせなど、UI の一覧のキャッシュを使わない・追い出さないコネクション。
    bypass: bool,
}

impl Handle {
    /// `scope` はこの DB を表す名前 (ファイルの DB はパス)。`monitor_path` があれば、data_version を
    /// 読む常駐コネクションをそのファイルに開く (初回だけ)。
    pub(crate) fn new(scope: &str, monitor_path: Option<&std::path::Path>) -> Self {
        let shared = shared(scope);
        if let Some(path) = monitor_path {
            let mut monitor = lock(&shared.monitor);
            if monitor.path.is_none() {
                monitor.path = Some(path.to_path_buf());
            }
        }
        Handle {
            shared,
            bypass: false,
        }
    }

    pub(crate) fn set_bypass(&mut self, bypass: bool) {
        self.bypass = bypass;
    }

    /// このコネクションの書き込みを見張り、コミットのたびにリビジョンを進める。
    pub(crate) fn watch(&self, conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
        use std::sync::atomic::{AtomicU8, Ordering};
        const ANY: u8 = 1;
        const RELEVANT: u8 = 2;
        // このトランザクションで触ったテーブルの種類。
        let touched = Arc::new(AtomicU8::new(0));
        let on_update = touched.clone();
        conn.update_hook(Some(
            move |_action: rusqlite::hooks::Action, _db: &str, table: &str, _rowid: i64| {
                let bits = if is_relevant_table(table) {
                    ANY | RELEVANT
                } else {
                    ANY
                };
                on_update.fetch_or(bits, Ordering::Relaxed);
            },
        ))?;
        let on_rollback = touched.clone();
        conn.rollback_hook(Some(move || {
            on_rollback.store(0, Ordering::Relaxed);
        }))?;
        let shared = self.shared.clone();
        conn.commit_hook(Some(move || {
            let bits = touched.swap(0, Ordering::Relaxed);
            // update hook が 1 度も呼ばれないコミット (WHERE なしの DELETE や DDL など、行単位の通知が
            // 出ない書き込み) は、何を触ったか分からないので一覧に関係するとみなす。
            let relevant = bits & RELEVANT != 0 || bits & ANY == 0;
            lock(&shared.scope).committed(relevant, Instant::now());
            false // コミットは止めない
        }))?;
        Ok(())
    }

    fn data_version(&self) -> Option<i64> {
        lock(&self.shared.monitor).data_version()
    }

    /// `key` の一覧の ID 列。使ってよいエントリがあればそれを、無ければ `compute` して覚える。
    /// 同じ `key` を同時に計算しない (後から来た呼び出しは待って、覚えた結果を使う)。
    pub(crate) fn get_or_compute(
        &self,
        key: &str,
        compute: impl FnOnce() -> rusqlite::Result<Vec<i64>>,
    ) -> rusqlite::Result<Arc<Vec<i64>>> {
        if self.bypass {
            return compute().map(Arc::new);
        }
        // data_version は scope のロックを取る前に読む (ロックを重ねない)。
        let version = self.data_version();
        if let Some(ids) = lock(&self.shared.scope).lookup(key, version, Instant::now()) {
            return Ok(ids);
        }
        let key_lock = lock(&self.shared.computing)
            .entry(key.to_string())
            .or_default()
            .clone();
        let result = {
            let _computing = lock(&key_lock);
            // 待っているあいだに、先の計算が覚えたかもしれない。
            let version = self.data_version();
            let cached = lock(&self.shared.scope).lookup(key, version, Instant::now());
            match cached {
                Some(ids) => Ok(ids),
                None => {
                    let version = self.data_version();
                    let before = lock(&self.shared.scope).stamp(version, Instant::now());
                    compute().map(|ids| {
                        let ids = Arc::new(ids);
                        let after = self.data_version();
                        lock(&self.shared.scope).store(
                            key.to_string(),
                            ids.clone(),
                            before,
                            after,
                            Instant::now(),
                        );
                        ids
                    })
                }
            }
        };
        // 待っている呼び出しがいなければ、ロックの置き場を片付ける。
        let mut computing = lock(&self.shared.computing);
        if computing
            .get(key)
            .is_some_and(|l| Arc::strong_count(l) <= 2)
        {
            computing.remove(key);
        }
        result
    }

    #[cfg(test)]
    pub(crate) fn settle(&self) {
        lock(&self.shared.scope).settle();
    }

    #[cfg(test)]
    pub(crate) fn drop_all(&self) {
        lock(&self.shared.scope).entries.clear();
    }
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

    fn ids(v: &[i64]) -> Arc<Vec<i64>> {
        Arc::new(v.to_vec())
    }

    /// 時刻を決められる土台。
    struct Clock(Instant);
    impl Clock {
        fn new() -> Self {
            Clock(Instant::now())
        }
        fn at(&self, ms: u64) -> Instant {
            self.0 + Duration::from_millis(ms)
        }
    }

    #[test]
    fn stores_and_reuses_until_a_relevant_commit() {
        let t = Clock::new();
        let mut s = Scope::default();
        let before = s.stamp(Some(7), t.at(0));
        assert!(s.store("k".into(), ids(&[3, 1, 2]), before, Some(7), t.at(1)));
        assert_eq!(*s.lookup("k", Some(7), t.at(2)).unwrap(), vec![3, 1, 2]);
        assert!(s.lookup("other", Some(7), t.at(2)).is_none());

        // 一覧に関係するコミット → 使わない。
        s.committed(true, t.at(10));
        assert!(s.lookup("k", Some(8), t.at(1000)).is_none());
    }

    #[test]
    fn irrelevant_commits_keep_the_cache() {
        let t = Clock::new();
        let mut s = Scope::default();
        let before = s.stamp(Some(7), t.at(0));
        assert!(s.store("k".into(), ids(&[1]), before, Some(7), t.at(1)));
        // 再生位置の保存: commit hook が呼ばれ (コミット数 +1)、完了すると data_version が変わる。
        s.committed(false, t.at(5000));
        assert!(s.lookup("k", Some(7), t.at(5000)).is_some(), "コミット完了前");
        assert!(s.lookup("k", Some(8), t.at(5001)).is_some(), "コミット完了後");
        s.committed(false, t.at(10_000));
        assert!(s.lookup("k", Some(9), t.at(10_001)).is_some());
    }

    #[test]
    fn external_write_drops_the_cache() {
        let t = Clock::new();
        let mut s = Scope::default();
        let before = s.stamp(Some(7), t.at(0));
        assert!(s.store("k".into(), ids(&[1]), before, Some(7), t.at(1)));
        // このプロセスのコミットが無いのに data_version が変わった = 別プロセスが書いた。
        assert!(s.lookup("k", Some(8), t.at(2)).is_none());
    }

    #[test]
    fn does_not_store_when_something_committed_during_the_computation() {
        let t = Clock::new();
        let mut s = Scope::default();
        // 計算中に一覧に関係するコミット (hook)。
        let before = s.stamp(Some(7), t.at(0));
        s.committed(true, t.at(5));
        assert!(!s.store("k".into(), ids(&[1]), before, Some(7), t.at(10)));
        // 計算中に、ほかのコネクションのコミットが完了した (data_version が変わった)。
        let before = s.stamp(Some(7), t.at(1000));
        assert!(!s.store("k".into(), ids(&[1]), before, Some(8), t.at(1010)));
    }

    /// commit hook はコミットの直前に呼ばれる。直後に始めた計算はコミット前の内容を読みうるが、
    /// そのコミットが完了すれば data_version が変わるので、古い列を使い続けることはない
    /// (計算に 250 ms 以上かかっても同じ)。
    #[test]
    fn entry_computed_right_after_a_commit_hook_is_dropped_when_that_commit_lands() {
        let t = Clock::new();
        let mut s = Scope::default();
        s.committed(true, t.at(0)); // hook。コミットはまだ完了していない (data_version = 7 のまま)
        let before = s.stamp(Some(7), t.at(1));
        // 長い計算 (400 ms)。そのあいだもコミットは完了していない。古い内容を読んだ。
        assert!(s.store("k".into(), ids(&[1]), before, Some(7), t.at(401)));
        assert!(
            s.lookup("k", Some(7), t.at(402)).is_some(),
            "まだコミットされていないので、DB の内容と一致している"
        );
        // 一覧に関係しないコミットが間に入っても、確定前のエントリは data_version でしか認めない。
        s.committed(false, t.at(450));
        assert!(s.lookup("k", Some(8), t.at(500)).is_none(), "コミットが完了したら捨てる");
    }

    #[test]
    fn entry_computed_after_the_commit_landed_survives_irrelevant_commits() {
        let t = Clock::new();
        let mut s = Scope::default();
        s.committed(true, t.at(0));
        // コミット完了 (data_version 7 → 8) のあと、SETTLE を過ぎてから計算。
        let before = s.stamp(Some(8), t.at(300));
        assert!(s.store("k".into(), ids(&[1]), before, Some(8), t.at(310)));
        s.committed(false, t.at(5000));
        assert!(s.lookup("k", Some(9), t.at(5001)).is_some());
    }

    #[test]
    fn without_data_version_nothing_is_stored_right_after_a_commit() {
        let t = Clock::new();
        let mut s = Scope::default();
        s.committed(true, t.at(0));
        let before = s.stamp(None, t.at(100));
        assert!(!s.store("k".into(), ids(&[1]), before, None, t.at(110)));
        let before = s.stamp(None, t.at(250));
        assert!(s.store("k".into(), ids(&[1]), before, None, t.at(260)));
        assert!(s.lookup("k", None, t.at(270)).is_some());
    }

    #[test]
    fn expires_and_evicts() {
        let t = Clock::new();
        let mut s = Scope::default();
        for i in 0..(MAX_ENTRIES as u64 + 3) {
            let before = s.stamp(Some(1), t.at(i));
            assert!(s.store(format!("k{i}"), ids(&[i as i64]), before, Some(1), t.at(i)));
        }
        assert!(s.lookup("k0", Some(1), t.at(100)).is_none(), "古いものから追い出す");
        assert!(s.lookup("k14", Some(1), t.at(100)).is_some());
        assert!(s.lookup("k14", Some(1), t.at(61_000)).is_none(), "TTL");
        // invalidate は全部捨てる。
        let before = s.stamp(Some(1), t.at(70_000));
        assert!(s.store("k".into(), ids(&[1]), before, Some(1), t.at(70_000)));
        s.invalidate(t.at(70_001));
        assert!(s.lookup("k", Some(1), t.at(80_000)).is_none());
    }

    #[test]
    fn relevant_tables() {
        for table in ["tracks", "playlists", "playlist_tracks", "track_analysis", "track_tags"] {
            assert!(is_relevant_table(table), "{table}");
        }
        for table in ["app_state", "play_queue", "playback_state", "recent_tracks"] {
            assert!(!is_relevant_table(table), "{table}");
        }
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
