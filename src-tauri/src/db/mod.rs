pub mod analysis;
pub mod playlists;
pub mod schema;
pub mod stats;
pub mod tracks;

use std::path::Path;

use rusqlite::functions::FunctionFlags;
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
        register_functions(&db.conn)?;
        schema::create_tables(&db.conn)?;
        migrate(&db.conn)?;
        Ok(db)
    }

    /// エクスポート用の読み取りスナップショットトランザクションを開始する。
    /// WAL モードの DEFERRED トランザクションにより、トランザクション開始時点の
    /// スナップショット (repeatable-read) が得られる。
    pub fn read_txn(&self) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        self.conn.unchecked_transaction()
    }
}

/// SQL から呼べるアプリ定義スカラー関数を登録する。`open` / `open_memory` の両方で使う。
/// `fold(text, level)`: CJK 字体ゆれを `level` (0=Off/1=Light/2=Standard) まで畳む。
/// NULL 列は NULL のまま返す。決定的なので SQLITE_DETERMINISTIC を付ける。
fn register_functions(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "fold",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let text: Option<String> = ctx.get(0)?;
            let level: i64 = ctx.get(1)?;
            Ok(text.map(|t| {
                crate::text_fold::fold(&t, crate::text_fold::FoldLevel::from_i64(level))
            }))
        },
    )?;
    Ok(())
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
        register_functions(&db.conn)?;
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
    if !column_exists(conn, "playlists", "smart_criteria")? {
        conn.execute_batch("ALTER TABLE playlists ADD COLUMN smart_criteria TEXT;")?;
    }
    migrate_search_text(conn)?;
    Ok(())
}

/// 検索高速化用の正規化済みカラム `search_text` を追加し、未計算行を一括バックフィルする。
/// `search_text` は name/artist/album/album_artist/genre/comments を Standard で fold して
/// 連結したもの (`tracks::SEARCH_TEXT_EXPR` が単一の真実の源)。検索の高速パスはこの 1 列のみを
/// `LIKE` で見るため、クエリ時の per-row fold() 呼び出しを排除できる。
fn migrate_search_text(conn: &Connection) -> Result<()> {
    let fresh = !column_exists(conn, "tracks", "search_text")?;
    if fresh {
        conn.execute_batch("ALTER TABLE tracks ADD COLUMN search_text TEXT;")?;
    }
    // 既存 DB のバックフィル: search_text が NULL の行を計算して埋める。
    // 新規 ALTER 直後は全行 NULL なので全件、再起動時は NULL 行のみ (冪等)。
    // トランザクション一括で、失敗時は自動ロールバック (execute_batch 内の BEGIN/COMMIT)。
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tracks WHERE search_text IS NULL",
        [],
        |r| r.get(0),
    )?;
    if pending > 0 {
        conn.execute_batch(&format!(
            "BEGIN;
             UPDATE tracks SET search_text = {expr} WHERE search_text IS NULL;
             COMMIT;",
            expr = crate::db::tracks::SEARCH_TEXT_EXPR,
        ))?;
    }
    Ok(())
}
