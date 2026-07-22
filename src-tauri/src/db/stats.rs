use rusqlite::{params, Result};

use super::Database;
use crate::models::LibraryStats;

impl Database {
    pub fn library_stats(&self) -> Result<LibraryStats> {
        let track_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
        let playlist_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM playlists WHERE is_folder = 0",
            [],
            |r| r.get(0),
        )?;
        let total_time_ms: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(total_time_ms), 0) FROM tracks",
            [],
            |r| r.get(0),
        )?;

        Ok(LibraryStats {
            track_count,
            playlist_count,
            total_time_ms,
        })
    }

    pub fn set_state(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO app_state (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_state(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM app_state WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get(0))?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// app_state の値を、未設定の場合だけ作成して返す。
    /// 複数リクエストが同時に初期化しても、PRIMARY KEY と INSERT OR IGNORE により
    /// 最初に保存された値を全リクエストが共有する。
    pub fn get_or_create_state(&self, key: &str, default_value: &str) -> Result<String> {
        self.conn.execute(
            "INSERT OR IGNORE INTO app_state (key, value) VALUES (?1, ?2)",
            params![key, default_value],
        )?;
        self.conn.query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
    }

    /// 自動整理が有効なら整理先ルートを返す。
    /// `library_root` が未設定 / 空、または `organize_enabled == "0"` のときは `None`。
    /// これを `None` とする限り、取り込み・編集時の整理処理は完全にスキップされ、
    /// 従来どおり (その場参照 / DB のみ更新) に振る舞う。
    pub fn organize_root(&self) -> Option<String> {
        let root = self.get_state("library_root").ok().flatten()?;
        if root.trim().is_empty() {
            return None;
        }
        match self.get_state("organize_enabled").ok().flatten() {
            Some(v) if v == "0" => None,
            _ => Some(root),
        }
    }
}
