//! 再生キューと再生状態の永続化 (#159)。
//!
//! - `play_queue`: 再生順 (`order`) の 1 要素 = 1 行。`order_index` 番目の再生順が
//!   `queue_index` 番目のキュー要素 (`track_id`) を指す。`order` は `0..queue.len()` の
//!   順列なので、この 1 表で queue と order (シャッフル順列) の両方を完全に表せる。
//! - `playback_state`: 1 行だけのテーブル (id = 1)。再生順上の位置 (`order_pos`)、
//!   読み込み中の曲・位置、shuffle / repeat / volume。
//!
//! 位置だけの更新は `playback_state` の 1 行 UPSERT で済み、キュー全体の書き直しは
//! キューが変わったときだけ行う (`save_playback(.., include_queue)`)。

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Result};

use super::Database;
use crate::audio::{prune_queue, RepeatMode};

/// DB に保存する / DB から復元する再生状態。
#[derive(Debug, Clone, PartialEq)]
pub struct PersistedPlayback {
    pub queue: Vec<i64>,
    pub order: Vec<usize>,
    pub order_pos: Option<usize>,
    pub track_id: Option<i64>,
    pub position_ms: u64,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    pub volume: f32,
}

/// テーブル作成 (冪等)。`db::migrate` から呼ぶ。
pub(super) fn migrate_playback_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS play_queue (
             order_index INTEGER PRIMARY KEY,
             queue_index INTEGER NOT NULL,
             track_id INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS playback_state (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             order_pos INTEGER,
             track_id INTEGER,
             position_ms INTEGER NOT NULL DEFAULT 0,
             shuffle INTEGER NOT NULL DEFAULT 0,
             repeat TEXT NOT NULL DEFAULT 'off',
             volume REAL NOT NULL DEFAULT 1.0,
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )?;
    Ok(())
}

fn repeat_to_str(r: RepeatMode) -> &'static str {
    match r {
        RepeatMode::Off => "off",
        RepeatMode::All => "all",
        RepeatMode::One => "one",
    }
}

fn repeat_from_str(s: &str) -> RepeatMode {
    match s {
        "all" => RepeatMode::All,
        "one" => RepeatMode::One,
        _ => RepeatMode::Off,
    }
}

impl Database {
    /// 再生状態を保存する。`include_queue` が true のときだけ `play_queue` を書き直す
    /// (位置の定期保存は `playback_state` の 1 行だけで済ませる)。
    pub fn save_playback(&self, p: &PersistedPlayback, include_queue: bool) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        if include_queue {
            tx.execute("DELETE FROM play_queue", [])?;
            let mut stmt = tx.prepare(
                "INSERT INTO play_queue (order_index, queue_index, track_id) VALUES (?1, ?2, ?3)",
            )?;
            for (order_index, &qi) in p.order.iter().enumerate() {
                let Some(&tid) = p.queue.get(qi) else {
                    continue;
                };
                stmt.execute(params![order_index as i64, qi as i64, tid])?;
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO playback_state
                 (id, order_pos, track_id, position_ms, shuffle, repeat, volume, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
            params![
                p.order_pos.map(|v| v as i64),
                p.track_id,
                p.position_ms as i64,
                p.shuffle as i64,
                repeat_to_str(p.repeat),
                p.volume as f64,
            ],
        )?;
        tx.commit()
    }

    /// 保存済みの再生状態を読み込む。未保存なら None。
    ///
    /// ライブラリから削除済みの曲はキューから取り除き、再生順上の位置を詰める。
    /// 読み込み中だった曲が削除済みなら、キューの現在位置の曲 (残っていれば) を
    /// 位置 0 で読み込む扱いにする。保存内容が壊れている (順列でない) 場合はキューを捨てる。
    pub fn load_playback(&self) -> Result<Option<PersistedPlayback>> {
        let row = self
            .conn
            .query_row(
                "SELECT order_pos, track_id, position_ms, shuffle, repeat, volume
                 FROM playback_state WHERE id = 1",
                [],
                |r| {
                    Ok((
                        r.get::<_, Option<i64>>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, f64>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((order_pos, track_id, position_ms, shuffle, repeat, volume)) = row else {
            return Ok(None);
        };

        // (queue_index, track_id, 曲がライブラリに残っているか) を再生順に読む。
        let mut stmt = self.conn.prepare(
            "SELECT q.queue_index, q.track_id,
                    EXISTS(SELECT 1 FROM tracks t WHERE t.track_id = q.track_id)
             FROM play_queue q ORDER BY q.order_index",
        )?;
        let rows: Vec<(i64, i64, bool)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_>>()?;

        let n = rows.len();
        let mut queue = vec![0i64; n];
        let mut order = Vec::with_capacity(n);
        let mut deleted: HashSet<i64> = HashSet::new();
        let mut valid = true;
        for &(qi, tid, exists) in &rows {
            if qi < 0 || qi as usize >= n {
                valid = false;
                break;
            }
            queue[qi as usize] = tid;
            order.push(qi as usize);
            if !exists {
                deleted.insert(tid);
            }
        }
        if !valid || !crate::audio::is_permutation(&order, n) {
            crate::logging::write_line("warn", "load_playback: corrupt play_queue, discarding");
            queue.clear();
            order.clear();
        }
        let order_pos = if order.is_empty() {
            None
        } else {
            Some(order_pos.unwrap_or(0).clamp(0, order.len() as i64 - 1) as usize)
        };
        let (queue, order, order_pos) = if deleted.is_empty() {
            (queue, order, order_pos)
        } else {
            prune_queue(&queue, &order, order_pos, &deleted)
        };

        // 読み込み中だった曲がライブラリから消えていたら、キュー上の現在位置の曲に倒す。
        let track_alive = match track_id {
            Some(tid) => self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tracks WHERE track_id = ?1)",
                params![tid],
                |r| r.get::<_, bool>(0),
            )?,
            None => true,
        };
        let (track_id, position_ms) = if track_alive {
            (track_id, position_ms.max(0) as u64)
        } else {
            let fallback = order_pos
                .and_then(|pos| order.get(pos))
                .and_then(|&qi| queue.get(qi))
                .copied();
            (fallback, 0)
        };

        Ok(Some(PersistedPlayback {
            queue,
            order,
            order_pos,
            track_id,
            position_ms,
            shuffle: shuffle != 0,
            repeat: repeat_from_str(&repeat),
            volume: (volume as f32).clamp(0.0, 1.0),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_track(db: &Database, track_id: i64) {
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name) VALUES (?1, 't')",
                params![track_id],
            )
            .unwrap();
    }

    fn sample() -> PersistedPlayback {
        PersistedPlayback {
            queue: vec![10, 20, 30, 40],
            // シャッフル済みの順列。
            order: vec![2, 0, 3, 1],
            order_pos: Some(1),
            track_id: Some(10),
            position_ms: 42_500,
            shuffle: true,
            repeat: RepeatMode::All,
            volume: 0.6,
        }
    }

    #[test]
    fn load_returns_none_when_never_saved() {
        let db = Database::open_memory().unwrap();
        assert_eq!(db.load_playback().unwrap(), None);
    }

    #[test]
    fn save_load_roundtrip_keeps_permutation_and_state() {
        let db = Database::open_memory().unwrap();
        for id in [10, 20, 30, 40] {
            insert_track(&db, id);
        }
        let p = sample();
        db.save_playback(&p, true).unwrap();
        assert_eq!(db.load_playback().unwrap(), Some(p.clone()));

        // 位置だけの保存はキューを書き直さず、状態だけ更新する。
        let mut moved = p.clone();
        moved.position_ms = 50_000;
        moved.volume = 0.25;
        moved.repeat = RepeatMode::One;
        db.save_playback(&moved, false).unwrap();
        assert_eq!(db.load_playback().unwrap(), Some(moved));

        // キューを空にして保存 → 空キューで戻る。
        let empty = PersistedPlayback {
            queue: vec![],
            order: vec![],
            order_pos: None,
            track_id: None,
            position_ms: 0,
            shuffle: false,
            repeat: RepeatMode::Off,
            volume: 1.0,
        };
        db.save_playback(&empty, true).unwrap();
        assert_eq!(db.load_playback().unwrap(), Some(empty));
    }

    #[test]
    fn load_skips_deleted_tracks_and_adjusts_position() {
        let db = Database::open_memory().unwrap();
        // 20 は削除済み (tracks に無い)。
        for id in [10, 30, 40] {
            insert_track(&db, id);
        }
        // 再生順: 30(0), 10(1), 40(2), 20(3)。現在位置 2 = 40。
        let mut p = sample();
        p.order_pos = Some(2);
        p.track_id = Some(40);
        db.save_playback(&p, true).unwrap();
        let loaded = db.load_playback().unwrap().unwrap();
        assert_eq!(loaded.queue, vec![10, 30, 40]);
        assert_eq!(loaded.order, vec![1, 0, 2]);
        assert_eq!(loaded.order_pos, Some(2));
        assert_eq!(loaded.track_id, Some(40));
        assert_eq!(loaded.position_ms, 42_500);

        // 削除済みの曲より後ろにいた場合は位置が 1 つ詰まる。
        let db = Database::open_memory().unwrap();
        for id in [10, 20, 40] {
            insert_track(&db, id);
        }
        // 30 (再生順 0) を削除。現在位置 2 = 40 → 新位置 1。
        db.save_playback(&p, true).unwrap();
        let loaded = db.load_playback().unwrap().unwrap();
        assert_eq!(loaded.queue, vec![10, 20, 40]);
        assert_eq!(loaded.order, vec![0, 2, 1]);
        assert_eq!(loaded.order_pos, Some(1));
        assert_eq!(loaded.track_id, Some(40));
    }

    #[test]
    fn load_falls_back_when_current_track_deleted() {
        let db = Database::open_memory().unwrap();
        // 10 (= 再生中の曲、再生順 1) を削除。
        for id in [20, 30, 40] {
            insert_track(&db, id);
        }
        db.save_playback(&sample(), true).unwrap();
        let loaded = db.load_playback().unwrap().unwrap();
        // 再生順: 30, 40, 20。現在位置は 10 の直後に残る 40 (位置 1)。
        assert_eq!(loaded.queue, vec![20, 30, 40]);
        assert_eq!(loaded.order, vec![1, 2, 0]);
        assert_eq!(loaded.order_pos, Some(1));
        assert_eq!(loaded.track_id, Some(40));
        assert_eq!(loaded.position_ms, 0);

        // 全曲削除済み → 空キュー・曲なし。設定値は残る。
        let db = Database::open_memory().unwrap();
        db.save_playback(&sample(), true).unwrap();
        let loaded = db.load_playback().unwrap().unwrap();
        assert!(loaded.queue.is_empty());
        assert!(loaded.order.is_empty());
        assert_eq!(loaded.order_pos, None);
        assert_eq!(loaded.track_id, None);
        assert!(loaded.shuffle);
        assert_eq!(loaded.repeat, RepeatMode::All);
    }

    #[test]
    fn load_discards_corrupt_queue() {
        let db = Database::open_memory().unwrap();
        insert_track(&db, 10);
        insert_track(&db, 20);
        db.save_playback(&sample(), false).unwrap();
        // queue_index が重複 = 順列でない。
        db.conn
            .execute_batch(
                "INSERT INTO play_queue VALUES (0, 0, 10);
                 INSERT INTO play_queue VALUES (1, 0, 20);",
            )
            .unwrap();
        let loaded = db.load_playback().unwrap().unwrap();
        assert!(loaded.queue.is_empty());
        assert_eq!(loaded.order_pos, None);
        assert_eq!(loaded.track_id, Some(10));
    }

    #[test]
    fn migration_is_idempotent() {
        let db = Database::open_memory().unwrap();
        migrate_playback_tables(&db.conn).unwrap();
        migrate_playback_tables(&db.conn).unwrap();
    }
}
