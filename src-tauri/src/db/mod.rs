pub mod analysis;
pub mod playlists;
pub mod schema;
pub mod stats;
pub mod tracks;

use std::path::Path;

use rusqlite::{Connection, Result};

pub struct Database {
    pub(crate) conn: Connection,
    #[allow(dead_code)]
    pub path: String,
}

impl Database {
    pub fn open(app_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(app_dir).ok();
        let db_path = app_dir.join("library.db");
        let path_str = db_path.to_string_lossy().to_string();
        let conn = Connection::open(&db_path)?;
        // busy_timeout: バックグラウンド解析ワーカと UI コマンドが別コネクションで
        // 同時アクセスしても SQLITE_BUSY で即失敗しないように待つ。
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;",
        )?;
        let db = Database {
            conn,
            path: path_str,
        };
        schema::create_tables(&db.conn)?;
        migrate(&db.conn)?;
        Ok(db)
    }
}

#[cfg(test)]
impl Database {
    /// テスト用のインメモリ DB (スキーマ + マイグレーション適用済み)。
    pub fn open_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Database {
            conn,
            path: ":memory:".to_string(),
        };
        schema::create_tables(&db.conn)?;
        migrate(&db.conn)?;
        Ok(db)
    }
}

/// 指定テーブルに列が存在するか (PRAGMA table_info)。
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    // table 名はコード内リテラルのみ (ユーザー入力ではない) なので format! で安全。
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `CREATE TABLE IF NOT EXISTS` では既存 DB に新カラムが追加されないため、
/// 後付けカラムは冪等な `ALTER TABLE ADD COLUMN` でここに集約する。
fn migrate(conn: &Connection) -> Result<()> {
    if !column_exists(conn, "tracks", "last_played")? {
        conn.execute_batch("ALTER TABLE tracks ADD COLUMN last_played TEXT;")?;
    }
    Ok(())
}
