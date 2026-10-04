//! 読み出し結果のプロセス内キャッシュを安全に無効化するための「世代カウンタ」(#213)。
//!
//! 各コマンドは都度 `Database::open` で別コネクションを開き、書き込み経路も
//! (解析ワーカ / LAN API の生 SQL / 同期・federation / 削除 / インポート…) 多岐に渡る。
//! Rust 側の書き込み関数ごとにカウンタを進める方式だと、1 経路の付け忘れが
//! 「古い結果を返し続ける」バグになる。そこで SQLite のトリガで
//! `cache_generation` テーブルの値を進め、**どの経路・どのコネクションからの書き込みでも**
//! 必ず世代が変わるようにする。キャッシュ側は読み出し前に 1 行引いて世代を比べるだけ。
//!
//! - `analysis`: 類似度の母集合 (`get_all_analysis` の結果) に効く変更。
//!   track_analysis の全変更 + tracks の INSERT/DELETE + tracks の track_id /
//!   key_camelot_user 更新 (実効キーと track_id の結合に効く)。
//! - `library`: スマートプレイリストのメンバー / 並び順に効く変更。
//!   tracks の全変更 + track_analysis の全変更。
//! - `uid`: DB ファイルごとの乱数 ID。別 DB (テストのインメモリ DB 等) と
//!   キャッシュを取り違えないためのもの。
//!
//! バックアップからの復元ではファイルごと差し替わり、復元後の DB の世代値が
//! 偶然キャッシュ時と一致しうるため、プロセス内エポック ([`bump_epoch`]) も
//! キャッシュキーに含める (`forget_migrated` から呼ぶ)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, Result};

/// DB ファイルの差し替え (復元) ごとに進めるプロセス内エポック。
static EPOCH: AtomicU64 = AtomicU64::new(0);

/// DB ファイルを差し替えたときに呼ぶ。以後すべてのキャッシュが無効になる。
pub fn bump_epoch() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
}

/// キャッシュの有効性判定に使う世代キー。全フィールドが一致する間だけキャッシュを使ってよい。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenKey {
    pub uid: i64,
    pub epoch: u64,
    pub value: i64,
}

/// 世代を進めるトリガ本体。`names` のカウンタを +1 する。
fn bump_sql(names: &str) -> String {
    format!("UPDATE cache_generation SET value = value + 1 WHERE name IN ({names});")
}

/// テーブルとトリガを (冪等に) 用意する。`migrate` の最後に呼ぶこと
/// (マイグレーションで作り直されたテーブルのトリガは消えるため、作り直しの後で張る)。
pub fn install(conn: &Connection) -> Result<()> {
    let both = bump_sql("'analysis', 'library'");
    let analysis = bump_sql("'analysis'");
    let library = bump_sql("'library'");
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS cache_generation (
             name TEXT PRIMARY KEY,
             value INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO cache_generation (name, value) VALUES
             ('uid', random()), ('analysis', 0), ('library', 0);

         CREATE TRIGGER IF NOT EXISTS cg_analysis_insert AFTER INSERT ON track_analysis
         BEGIN {both} END;
         CREATE TRIGGER IF NOT EXISTS cg_analysis_update AFTER UPDATE ON track_analysis
         BEGIN {both} END;
         CREATE TRIGGER IF NOT EXISTS cg_analysis_delete AFTER DELETE ON track_analysis
         BEGIN {both} END;

         CREATE TRIGGER IF NOT EXISTS cg_tracks_insert AFTER INSERT ON tracks
         BEGIN {both} END;
         CREATE TRIGGER IF NOT EXISTS cg_tracks_delete AFTER DELETE ON tracks
         BEGIN {both} END;
         CREATE TRIGGER IF NOT EXISTS cg_tracks_update_analysis
         AFTER UPDATE OF track_id, key_camelot_user ON tracks
         BEGIN {analysis} END;
         CREATE TRIGGER IF NOT EXISTS cg_tracks_update AFTER UPDATE ON tracks
         BEGIN {library} END;"
    ))
}

/// 指定カウンタの現在の世代キー。テーブルが無い等で読めなければ None
/// (呼び出し側はキャッシュを使わず素直に計算する)。
pub fn current(conn: &Connection, name: &str) -> Option<GenKey> {
    // エポックは DB を読む前に取る (読んだ後に復元が走っても、古いエポックで
    // 記録されるだけなので次回は必ず再計算になる)。
    let epoch = EPOCH.load(Ordering::SeqCst);
    conn.query_row(
        "SELECT (SELECT value FROM cache_generation WHERE name = 'uid'),
                (SELECT value FROM cache_generation WHERE name = ?1)",
        [name],
        |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
    )
    .ok()
    .and_then(|(uid, value)| {
        Some(GenKey {
            uid: uid?,
            epoch,
            value: value?,
        })
    })
}

/// 世代キー付きの小さなプロセス内キャッシュ。
///
/// `slot` (何のキャッシュか: DB の uid やプレイリスト ID) ごとに 1 エントリだけ持ち、
/// `key` (有効性: 世代キー + 条件) が一致したときだけ再利用する。一致しなければ
/// 計算し直して置き換える。スロット数が `cap` を超えたら最も長く使われていないものを捨てる。
pub struct GenCache<S, K, V> {
    inner: Mutex<GenCacheInner<S, K, V>>,
    cap: usize,
}

struct GenCacheInner<S, K, V> {
    slots: Vec<(S, K, Arc<V>, u64)>,
    tick: u64,
}

impl<S: PartialEq, K: PartialEq, V> GenCache<S, K, V> {
    pub const fn new(cap: usize) -> Self {
        GenCache {
            inner: Mutex::new(GenCacheInner {
                slots: Vec::new(),
                tick: 0,
            }),
            cap,
        }
    }

    /// `slot` のエントリが `key` と一致すれば返し、そうでなければ `compute` して格納する。
    /// 計算中はロックを持たない (重い計算で他スロットの読み出しを塞がない)。
    /// 同時に 2 本が計算した場合は後勝ちになるが、どちらも同じ key の正しい値なので問題ない。
    pub fn get_or_try_insert<E>(
        &self,
        slot: S,
        key: K,
        compute: impl FnOnce() -> Result<V, E>,
    ) -> Result<Arc<V>, E> {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.tick += 1;
            let tick = inner.tick;
            if let Some(entry) = inner
                .slots
                .iter_mut()
                .find(|(s, k, _, _)| *s == slot && *k == key)
            {
                entry.3 = tick;
                return Ok(Arc::clone(&entry.2));
            }
        }
        let value = Arc::new(compute()?);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.tick += 1;
        let tick = inner.tick;
        inner.slots.retain(|(s, _, _, _)| *s != slot);
        inner.slots.push((slot, key, Arc::clone(&value), tick));
        while inner.slots.len() > self.cap.max(1) {
            if let Some(oldest) = inner
                .slots
                .iter()
                .enumerate()
                .min_by_key(|(_, e)| e.3)
                .map(|(i, _)| i)
            {
                inner.slots.remove(oldest);
            }
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    /// GenCache: 同じ key ならヒット (再計算しない)、key が変われば再計算、
    /// スロット上限を超えたら最古を捨てる。
    #[test]
    fn gen_cache_hits_and_recomputes_on_key_change() {
        let cache: GenCache<i64, i64, String> = GenCache::new(2);
        let mut calls = 0;
        let mut get = |slot: i64, key: i64| {
            cache
                .get_or_try_insert(slot, key, || {
                    calls += 1;
                    Ok::<_, ()>(format!("{slot}:{key}"))
                })
                .unwrap()
        };
        assert_eq!(*get(1, 10), "1:10");
        assert_eq!(*get(1, 10), "1:10");
        drop(get);
        assert_eq!(calls, 1, "same key must hit");

        let mut calls = 0;
        let mut get = |slot: i64, key: i64| {
            cache
                .get_or_try_insert(slot, key, || {
                    calls += 1;
                    Ok::<_, ()>(format!("{slot}:{key}"))
                })
                .unwrap()
        };
        // 世代が進んだ (key 変化) → 再計算して置き換え。
        assert_eq!(*get(1, 11), "1:11");
        assert_eq!(*get(1, 11), "1:11");
        // 別スロットは独立。
        assert_eq!(*get(2, 10), "2:10");
        // 上限 2 を超えると最も古く使われた slot 1 が捨てられる。
        assert_eq!(*get(3, 10), "3:10");
        assert_eq!(*get(1, 11), "1:11");
        drop(get);
        assert_eq!(calls, 4);
    }

    /// 計算が失敗した場合は何も格納せず、エラーを返す。
    #[test]
    fn gen_cache_does_not_store_errors() {
        let cache: GenCache<i64, i64, i64> = GenCache::new(4);
        let r: Result<Arc<i64>, &str> = cache.get_or_try_insert(1, 1, || Err("boom"));
        assert!(r.is_err());
        let v = cache.get_or_try_insert(1, 1, || Ok::<_, &str>(7)).unwrap();
        assert_eq!(*v, 7);
    }

    fn gen(db: &Database, name: &str) -> i64 {
        current(&db.conn, name).unwrap().value
    }

    /// 各テーブルへの書き込みで、期待するカウンタだけが進むこと。
    #[test]
    fn triggers_bump_expected_counters() {
        let db = Database::open_memory().unwrap();
        let (a0, l0) = (gen(&db, "analysis"), gen(&db, "library"));

        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name) VALUES (1, 'P1', 'x')",
                [],
            )
            .unwrap();
        let (a1, l1) = (gen(&db, "analysis"), gen(&db, "library"));
        assert!(a1 > a0 && l1 > l0, "tracks insert bumps both");

        // 解析に無関係な列の更新は library のみ。
        db.conn
            .execute("UPDATE tracks SET play_count = 3 WHERE track_id = 1", [])
            .unwrap();
        let (a2, l2) = (gen(&db, "analysis"), gen(&db, "library"));
        assert_eq!(a2, a1, "play_count update must not invalidate analysis cache");
        assert!(l2 > l1);

        // Key 上書きは両方。
        db.conn
            .execute(
                "UPDATE tracks SET key_camelot_user = '8A' WHERE track_id = 1",
                [],
            )
            .unwrap();
        let (a3, l3) = (gen(&db, "analysis"), gen(&db, "library"));
        assert!(a3 > a2 && l3 > l2);

        // track_analysis の insert / update / delete は両方。
        db.conn
            .execute(
                "INSERT INTO track_analysis (persistent_id, track_id, version) VALUES ('P1', 1, 2)",
                [],
            )
            .unwrap();
        let a4 = gen(&db, "analysis");
        assert!(a4 > a3);
        db.conn
            .execute("UPDATE track_analysis SET bpm = 120 WHERE persistent_id = 'P1'", [])
            .unwrap();
        let a5 = gen(&db, "analysis");
        assert!(a5 > a4);
        db.conn
            .execute("DELETE FROM track_analysis WHERE persistent_id = 'P1'", [])
            .unwrap();
        let a6 = gen(&db, "analysis");
        assert!(a6 > a5);

        // tracks の削除は両方。
        let l6 = gen(&db, "library");
        db.conn
            .execute("DELETE FROM tracks WHERE track_id = 1", [])
            .unwrap();
        assert!(gen(&db, "analysis") > a6 && gen(&db, "library") > l6);
    }

    /// install は冪等で、既存の世代値と uid を壊さない。
    #[test]
    fn install_is_idempotent() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute("INSERT INTO tracks (track_id, name) VALUES (1, 'x')", [])
            .unwrap();
        let before = current(&db.conn, "analysis").unwrap();
        install(&db.conn).unwrap();
        let after = current(&db.conn, "analysis").unwrap();
        assert_eq!(before, after);
    }

    /// 復元相当 (bump_epoch) でキーが変わる。別 DB は uid で区別される
    /// (乱数なので 2^-64 で衝突しうるが、テストでは実質起きない)。
    #[test]
    fn epoch_and_uid_distinguish_keys() {
        let db = Database::open_memory().unwrap();
        let k1 = current(&db.conn, "analysis").unwrap();
        bump_epoch();
        let k2 = current(&db.conn, "analysis").unwrap();
        assert_ne!(k1, k2);
        let other = Database::open_memory().unwrap();
        assert_ne!(current(&other.conn, "analysis").unwrap().uid, k2.uid);
    }
}
