pub mod analysis;
pub mod playlists;
pub mod schema;
pub mod stats;
pub mod tracks;

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, Result};

static PERSISTENT_ID_NONCE: AtomicU64 = AtomicU64::new(0);
pub(crate) const MAX_CONSTRAINT_ATTEMPTS: usize = 8;

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
            Ok(text
                .map(|t| crate::text_fold::fold(&t, crate::text_fold::FoldLevel::from_i64(level))))
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
    migrate_persistent_ids(conn)?;
    migrate_track_analysis(conn)?;
    migrate_search_text(conn)?;
    Ok(())
}

/// 解析結果の主キーを、再インポートで変わり得る track_id から persistent_id へ移す。
/// 現在の tracks に結び付かない旧行は persistent_id を復元できないため破棄する。
fn migrate_track_analysis(conn: &Connection) -> Result<()> {
    if column_exists(conn, "track_analysis", "persistent_id")? {
        return Ok(());
    }

    conn.execute_batch(
        "BEGIN;
         CREATE TABLE track_analysis_new (
             persistent_id TEXT PRIMARY KEY,
             track_id INTEGER,
             version INTEGER NOT NULL,
             analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
             bpm REAL,
             key_camelot TEXT,
             key_name TEXT,
             energy REAL,
             loudness_lufs REAL,
             replaygain_db REAL,
             vector TEXT,
             peaks TEXT
         );
         INSERT INTO track_analysis_new
             (persistent_id, track_id, version, analyzed_at, bpm, key_camelot, key_name,
              energy, loudness_lufs, replaygain_db, vector, peaks)
         SELECT tracks.persistent_id, old.track_id, old.version, old.analyzed_at,
                old.bpm, old.key_camelot, old.key_name, old.energy, old.loudness_lufs,
                old.replaygain_db, old.vector, old.peaks
         FROM track_analysis AS old
         JOIN tracks ON tracks.track_id = old.track_id;
         DROP TABLE track_analysis;
         ALTER TABLE track_analysis_new RENAME TO track_analysis;
         CREATE INDEX idx_analysis_track_id ON track_analysis(track_id);
         CREATE INDEX idx_analysis_bpm ON track_analysis(bpm);
         CREATE INDEX idx_analysis_key ON track_analysis(key_camelot);
         COMMIT;",
    )?;
    Ok(())
}

/// 現在時刻・行ごとの seed・プロセス内 nonce から iTunes 互換の 16 桁 ID を生成する。
/// nonce により、時計の分解能内で連続生成しても毎回異なる候補を作る。
pub(crate) fn generate_persistent_id(seed: u64) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let nonce = PERSISTENT_ID_NONCE.fetch_add(1, Ordering::Relaxed);
    format!("{:016X}", nanos ^ seed ^ nonce.rotate_left(32))
}

fn persistent_id_exists(conn: &Connection, table: &str, persistent_id: &str) -> Result<bool> {
    // table 名はコード内リテラルのみ (ユーザー入力ではない) なので format! で安全。
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE persistent_id = ?1)"),
        [persistent_id],
        |r| r.get(0),
    )
}

/// 対象テーブル内で未使用の persistent_id 候補を返す。
/// UNIQUE index 作成前のマイグレーションでも衝突を回避できるよう、明示的に存在確認する。
pub(crate) fn generate_unique_persistent_id(
    conn: &Connection,
    table: &str,
    seed: u64,
) -> Result<String> {
    loop {
        let persistent_id = generate_persistent_id(seed);
        if !persistent_id_exists(conn, table, &persistent_id)? {
            return Ok(persistent_id);
        }
    }
}

/// XML 由来 ID は空文字を欠損扱いにし、同一インポート内で既出なら新規生成する。
pub(crate) fn persistent_id_for_insert(
    conn: &Connection,
    table: &str,
    supplied: Option<&str>,
    seed: u64,
) -> Result<String> {
    if let Some(persistent_id) = supplied.filter(|id| !id.is_empty()) {
        if !persistent_id_exists(conn, table, persistent_id)? {
            return Ok(persistent_id.to_string());
        }
    }
    generate_unique_persistent_id(conn, table, seed)
}

fn is_constraint_violation(err: &rusqlite::Error) -> bool {
    err.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation)
}

pub(crate) fn should_retry_constraint(err: &rusqlite::Error, attempt: usize) -> bool {
    attempt + 1 < MAX_CONSTRAINT_ATTEMPTS && is_constraint_violation(err)
}

/// NULL・空文字・重複 ID (rowid が後の行) を再採番した後、UNIQUE index を作成する。
fn migrate_persistent_ids(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;

    for table in ["tracks", "playlists"] {
        let rowids = {
            let mut stmt = tx.prepare(&format!(
                "SELECT current.rowid
                 FROM {table} AS current
                 WHERE current.persistent_id IS NULL
                    OR current.persistent_id = ''
                    OR EXISTS (
                        SELECT 1 FROM {table} AS earlier
                        WHERE earlier.persistent_id = current.persistent_id
                          AND earlier.rowid < current.rowid
                    )
                 ORDER BY current.rowid"
            ))?;
            let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
            rows.collect::<Result<Vec<_>>>()?
        };

        for rowid in rowids {
            let mut attempt = 0;
            loop {
                let persistent_id = generate_unique_persistent_id(&tx, table, rowid as u64)?;
                match tx.execute(
                    &format!("UPDATE {table} SET persistent_id = ?1 WHERE rowid = ?2"),
                    rusqlite::params![persistent_id, rowid],
                ) {
                    Ok(_) => break,
                    Err(err) if should_retry_constraint(&err, attempt) => {
                        attempt += 1;
                        continue;
                    }
                    Err(err) => return Err(err),
                }
            }
        }
    }

    tx.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_persistent_id_unique
             ON tracks(persistent_id);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_persistent_id_unique
             ON playlists(persistent_id);",
    )?;
    tx.commit()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::analysis::ANALYSIS_VERSION;
    use crate::itunes_xml::parser::{PlistValue, RawPlaylist, RawTrack};
    use crate::models::TrackAnalysis;
    use std::collections::{HashMap, HashSet};

    fn legacy_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        register_functions(&conn).unwrap();
        schema::create_tables(&conn).unwrap();
        conn
    }

    fn legacy_analysis_connection() -> Connection {
        let conn = legacy_connection();
        conn.execute_batch(
            "DROP TABLE track_analysis;
             CREATE TABLE track_analysis (
                 track_id INTEGER PRIMARY KEY,
                 version INTEGER NOT NULL,
                 analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
                 bpm REAL,
                 key_camelot TEXT,
                 key_name TEXT,
                 energy REAL,
                 loudness_lufs REAL,
                 replaygain_db REAL,
                 vector TEXT,
                 peaks TEXT
             );
             CREATE INDEX idx_analysis_bpm ON track_analysis(bpm);
             CREATE INDEX idx_analysis_key ON track_analysis(key_camelot);",
        )
        .unwrap();
        conn
    }

    fn raw_track(track_id: i64, persistent_id: &str) -> RawTrack {
        let mut raw = RawTrack::default();
        raw.fields
            .insert("Track ID".to_string(), PlistValue::Int(track_id));
        raw.fields.insert(
            "Persistent ID".to_string(),
            PlistValue::Str(persistent_id.to_string()),
        );
        raw
    }

    fn named_track(
        track_id: i64,
        persistent_id: &str,
        name: &str,
        date_modified: &str,
    ) -> RawTrack {
        let mut raw = raw_track(track_id, persistent_id);
        raw.fields
            .insert("Name".to_string(), PlistValue::Str(name.to_string()));
        raw.fields.insert(
            "Date Modified".to_string(),
            PlistValue::Date(date_modified.to_string()),
        );
        raw
    }

    fn raw_playlist(
        playlist_id: i64,
        persistent_id: &str,
        name: &str,
        track_ids: Vec<i64>,
    ) -> RawPlaylist {
        let mut raw = RawPlaylist::default();
        raw.fields
            .insert("Playlist ID".to_string(), PlistValue::Int(playlist_id));
        raw.fields.insert(
            "Playlist Persistent ID".to_string(),
            PlistValue::Str(persistent_id.to_string()),
        );
        raw.fields
            .insert("Name".to_string(), PlistValue::Str(name.to_string()));
        raw.track_ids = track_ids;
        raw
    }

    fn merge_tracks(db: &Database, tracks: &[RawTrack]) -> HashMap<i64, i64> {
        let mut track_id_map = HashMap::new();
        let mut imported_persistent_ids = HashSet::new();
        let mut imported_track_ids = HashSet::new();
        for raw in tracks {
            let db_track_id = db
                .insert_track(
                    raw,
                    "",
                    true,
                    &mut imported_persistent_ids,
                    &mut imported_track_ids,
                )
                .unwrap();
            track_id_map.insert(raw.get_int("Track ID").unwrap_or(0), db_track_id);
        }
        track_id_map
    }

    fn analysis(track_id: i64, bpm: f64) -> TrackAnalysis {
        TrackAnalysis {
            track_id,
            version: ANALYSIS_VERSION,
            analyzed_at: "2026-07-22T00:00:00Z".to_string(),
            bpm: Some(bpm),
            key_camelot: Some("8A".to_string()),
            key_name: Some("A minor".to_string()),
            energy: Some(0.75),
            loudness_lufs: Some(-9.5),
            replaygain_db: Some(-4.5),
            vector: vec![0.1, 0.2],
            peaks: vec![0.25, 0.5],
        }
    }

    fn assert_non_empty_unique_ids(conn: &Connection, table: &str, expected: usize) {
        let mut stmt = conn
            .prepare(&format!("SELECT persistent_id FROM {table} ORDER BY rowid"))
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_>>()
            .unwrap();
        assert_eq!(ids.len(), expected);
        assert!(ids.iter().all(|id| !id.is_empty()));
        assert!(ids.iter().all(|id| {
            id.len() == 16
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
        }));
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), expected);
    }

    #[test]
    fn migration_backfills_persistent_ids_and_is_idempotent() {
        let conn = legacy_connection();
        conn.execute_batch(
            "INSERT INTO tracks (track_id, persistent_id) VALUES
                (1, NULL), (2, ''), (3, 'ABCDEF0123456789'), (4, 'ABCDEF0123456789');
             INSERT INTO playlists
                (playlist_id, persistent_id, parent_persistent_id, name) VALUES
                (10, NULL, NULL, 'missing'),
                (11, '', NULL, 'empty'),
                (12, '1234567890ABCDEF', NULL, 'retained'),
                (13, '1234567890ABCDEF', NULL, 'duplicate'),
                (14, 'FEDCBA0987654321', '1234567890ABCDEF', 'child');",
        )
        .unwrap();

        migrate(&conn).unwrap();
        assert_non_empty_unique_ids(&conn, "tracks", 4);
        assert_non_empty_unique_ids(&conn, "playlists", 5);

        let retained_track: String = conn
            .query_row(
                "SELECT persistent_id FROM tracks WHERE track_id = 3",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(retained_track, "ABCDEF0123456789");
        let retained_playlist: String = conn
            .query_row(
                "SELECT persistent_id FROM playlists WHERE playlist_id = 12",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(retained_playlist, "1234567890ABCDEF");
        let child_parent: String = conn
            .query_row(
                "SELECT parent_persistent_id FROM playlists WHERE playlist_id = 14",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(child_parent, "1234567890ABCDEF");

        assert!(conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id) VALUES (5, 'ABCDEF0123456789')",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO playlists (playlist_id, persistent_id, name)
                 VALUES (15, '1234567890ABCDEF', 'duplicate rejected')",
                [],
            )
            .is_err());

        let before: Vec<(String, String)> = ["tracks", "playlists"]
            .into_iter()
            .flat_map(|table| {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT CAST(rowid AS TEXT), persistent_id FROM {table} ORDER BY rowid"
                    ))
                    .unwrap();
                stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                    .unwrap()
                    .collect::<Result<Vec<_>>>()
                    .unwrap()
            })
            .collect();
        migrate(&conn).unwrap();
        let after: Vec<(String, String)> = ["tracks", "playlists"]
            .into_iter()
            .flat_map(|table| {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT CAST(rowid AS TEXT), persistent_id FROM {table} ORDER BY rowid"
                    ))
                    .unwrap();
                stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                    .unwrap()
                    .collect::<Result<Vec<_>>>()
                    .unwrap()
            })
            .collect();
        assert_eq!(before, after);
    }

    #[test]
    fn constraint_retry_is_bounded() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id) VALUES (1, 'RETRYBOUND000001')",
                [],
            )
            .unwrap();
        let err = db
            .conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id) VALUES (1, 'RETRYBOUND000002')",
                [],
            )
            .unwrap_err();

        assert!(should_retry_constraint(&err, 0));
        assert!(!should_retry_constraint(&err, MAX_CONSTRAINT_ATTEMPTS - 1));
    }

    #[test]
    fn track_analysis_migration_keeps_linked_rows_and_drops_orphans() {
        let conn = legacy_analysis_connection();
        conn.execute_batch(
            "INSERT INTO tracks (track_id, persistent_id) VALUES
                 (5, 'AAAAAAAAAAAAAAAA');
             INSERT INTO track_analysis
                 (track_id, version, analyzed_at, bpm, key_camelot, key_name, energy,
                  loudness_lufs, replaygain_db, vector, peaks)
             VALUES
                 (5, 2, '2026-01-02T03:04:05Z', 128.5, '8A', 'A minor', 0.75,
                  -9.5, -4.5, '[0.1,0.2]', '[0.25,0.5]'),
                 (99, 2, '2026-01-01T00:00:00Z', 90.0, '1A', 'A-flat minor', 0.2,
                  -12.0, -1.0, '[0.9]', '[0.8]');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let migrated: (String, i64, i64, String, f64, String, String) = conn
            .query_row(
                "SELECT persistent_id, track_id, version, analyzed_at, bpm, vector, peaks
                 FROM track_analysis",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            migrated,
            (
                "AAAAAAAAAAAAAAAA".to_string(),
                5,
                2,
                "2026-01-02T03:04:05Z".to_string(),
                128.5,
                "[0.1,0.2]".to_string(),
                "[0.25,0.5]".to_string(),
            )
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_analysis", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn track_analysis_migration_is_idempotent() {
        let conn = legacy_analysis_connection();
        conn.execute_batch(
            "INSERT INTO tracks (track_id, persistent_id) VALUES (5, 'AAAAAAAAAAAAAAAA');
             INSERT INTO track_analysis (track_id, version, analyzed_at, bpm)
             VALUES (5, 2, '2026-01-02T03:04:05Z', 128.5);",
        )
        .unwrap();

        migrate(&conn).unwrap();
        migrate(&conn).unwrap();

        assert!(column_exists(&conn, "track_analysis", "persistent_id").unwrap());
        let row: (String, i64, f64) = conn
            .query_row(
                "SELECT persistent_id, track_id, bpm FROM track_analysis",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("AAAAAAAAAAAAAAAA".to_string(), 5, 128.5));
    }

    #[test]
    fn merge_preserves_app_owned_track_fields() {
        let db = Database::open_memory().unwrap();
        let mut initial = named_track(1, "AAAAAAAAAAAAAAAA", "Initial", "2026-01-01T00:00:00Z");
        initial
            .fields
            .insert("Rating".to_string(), PlistValue::Int(20));
        initial
            .fields
            .insert("Play Count".to_string(), PlistValue::Int(3));
        db.begin_import().unwrap();
        merge_tracks(&db, &[initial]);
        db.finish_import().unwrap();
        db.conn
            .execute(
                "UPDATE tracks SET rating = 80, play_count = 99, skip_count = 7,
                 last_played = '2026-03-01T00:00:00Z', disabled = 1
                 WHERE persistent_id = 'AAAAAAAAAAAAAAAA'",
                [],
            )
            .unwrap();

        let mut incoming = named_track(1, "AAAAAAAAAAAAAAAA", "XML rename", "2026-04-01T00:00:00Z");
        incoming
            .fields
            .insert("Rating".to_string(), PlistValue::Int(10));
        incoming
            .fields
            .insert("Play Count".to_string(), PlistValue::Int(1));
        incoming
            .fields
            .insert("Skip Count".to_string(), PlistValue::Int(0));
        db.begin_import().unwrap();
        merge_tracks(&db, &[incoming]);
        db.finish_import().unwrap();

        let protected: (i64, i64, i64, String, i64) = db
            .conn
            .query_row(
                "SELECT rating, play_count, skip_count, last_played, disabled
                 FROM tracks WHERE persistent_id = 'AAAAAAAAAAAAAAAA'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            protected,
            (80, 99, 7, "2026-03-01T00:00:00Z".to_string(), 1)
        );
    }

    #[test]
    fn merge_uses_date_modified_for_xml_metadata() {
        let db = Database::open_memory().unwrap();
        db.begin_import().unwrap();
        merge_tracks(
            &db,
            &[named_track(
                1,
                "AAAAAAAAAAAAAAAA",
                "Original",
                "2026-01-01T00:00:00Z",
            )],
        );
        db.finish_import().unwrap();

        db.begin_import().unwrap();
        merge_tracks(
            &db,
            &[named_track(
                99,
                "AAAAAAAAAAAAAAAA",
                "New XML name",
                "2026-02-01T00:00:00Z",
            )],
        );
        db.finish_import().unwrap();
        let renamed: (i64, String) = db
            .conn
            .query_row(
                "SELECT track_id, name FROM tracks WHERE persistent_id = 'AAAAAAAAAAAAAAAA'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(renamed, (1, "New XML name".to_string()));

        db.conn
            .execute(
                "UPDATE tracks SET name = 'Local edit', date_modified = '2026-03-01T00:00:00Z'
                 WHERE persistent_id = 'AAAAAAAAAAAAAAAA'",
                [],
            )
            .unwrap();
        db.begin_import().unwrap();
        merge_tracks(
            &db,
            &[named_track(
                1,
                "AAAAAAAAAAAAAAAA",
                "Older XML name",
                "2026-02-15T00:00:00Z",
            )],
        );
        db.finish_import().unwrap();
        let name: String = db
            .conn
            .query_row(
                "SELECT name FROM tracks WHERE persistent_id = 'AAAAAAAAAAAAAAAA'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Local edit");
    }

    #[test]
    fn rating_edit_does_not_block_newer_xml_metadata() {
        let db = Database::open_memory().unwrap();
        let mut initial = named_track(1, "RATINGCLOCK00001", "Original", "2026-01-01T00:00:00Z");
        initial
            .fields
            .insert("Rating".to_string(), PlistValue::Int(20));
        db.begin_import().unwrap();
        merge_tracks(&db, &[initial]);
        db.finish_import().unwrap();

        db.set_rating(1, 80).unwrap();
        let modified_after_rating: String = db
            .conn
            .query_row(
                "SELECT date_modified FROM tracks WHERE track_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(modified_after_rating, "2026-01-01T00:00:00Z");

        db.begin_import().unwrap();
        merge_tracks(
            &db,
            &[named_track(
                99,
                "RATINGCLOCK00001",
                "New XML name",
                "2026-02-01T00:00:00Z",
            )],
        );
        db.finish_import().unwrap();

        let merged: (String, i64) = db
            .conn
            .query_row(
                "SELECT name, rating FROM tracks WHERE persistent_id = 'RATINGCLOCK00001'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(merged, ("New XML name".to_string(), 80));
    }

    #[test]
    fn merge_leaves_tracks_absent_from_xml_untouched() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks
                 (track_id, persistent_id, name, rating, location_path, file_exists)
                 VALUES (7, 'ABSENT0000000000', 'Local only', 100, '/music/local.mp3', 1)",
                [],
            )
            .unwrap();
        db.begin_import().unwrap();
        merge_tracks(&db, &[raw_track(1, "PRESENT000000000")]);
        db.finish_import().unwrap();

        let untouched: (String, i64, String, i64) = db
            .conn
            .query_row(
                "SELECT name, rating, location_path, file_exists
                 FROM tracks WHERE persistent_id = 'ABSENT0000000000'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            untouched,
            (
                "Local only".to_string(),
                100,
                "/music/local.mp3".to_string(),
                1
            )
        );
    }

    #[test]
    fn colliding_xml_track_is_remapped_and_playlist_uses_remapped_id() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, file_exists)
                 VALUES (5, 'LOCAL00000000000', 'App track', 1)",
                [],
            )
            .unwrap();
        db.begin_import().unwrap();
        let track_id_map = merge_tracks(&db, &[raw_track(5, "XML0000000000000")]);
        let mut playlist_ids = HashSet::new();
        let mut claimed_playlist_ids = HashSet::new();
        db.insert_playlist(
            &raw_playlist(10, "PLAYLIST00000001", "XML playlist", vec![5]),
            0,
            &track_id_map,
            &mut playlist_ids,
            &mut claimed_playlist_ids,
        )
        .unwrap();
        db.finish_import().unwrap();

        let xml_track_id: i64 = db
            .conn
            .query_row(
                "SELECT track_id FROM tracks WHERE persistent_id = 'XML0000000000000'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(xml_track_id, 6);
        assert_eq!(db.get_playlist_track_ids(10).unwrap(), vec![6]);
        let local_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE track_id = 5",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(local_count, 1);
    }

    #[test]
    fn matched_playlist_replaces_membership_and_local_playlist_is_untouched() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO tracks (track_id, persistent_id, name, file_exists) VALUES
                     (1, 'TRACK000000000001', 'One', 1),
                     (2, 'TRACK000000000002', 'Two', 1);
                 INSERT INTO playlists
                     (playlist_id, persistent_id, name, is_smart, is_user_created, smart_criteria)
                 VALUES
                     (10, 'PLAYLIST00000001', 'Old XML name', 1, 0, '{\"match\":\"all\"}'),
                     (20, 'LOCALPLAYLIST001', 'Local playlist', 0, 1, NULL);
                 INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES
                     (10, 1, 0), (20, 1, 0);",
            )
            .unwrap();

        db.begin_import().unwrap();
        let track_id_map = merge_tracks(
            &db,
            &[
                raw_track(1, "TRACK000000000001"),
                raw_track(2, "TRACK000000000002"),
            ],
        );
        let mut playlist_ids = HashSet::new();
        let mut claimed_playlist_ids = HashSet::new();
        db.insert_playlist(
            &raw_playlist(999, "PLAYLIST00000001", "Updated XML name", vec![2]),
            4,
            &track_id_map,
            &mut playlist_ids,
            &mut claimed_playlist_ids,
        )
        .unwrap();
        db.finish_import().unwrap();

        assert_eq!(db.get_playlist_track_ids(10).unwrap(), vec![2]);
        assert_eq!(db.get_playlist_track_ids(20).unwrap(), vec![1]);
        let matched: (String, i64, String) = db
            .conn
            .query_row(
                "SELECT name, is_smart, smart_criteria FROM playlists WHERE playlist_id = 10",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            matched,
            (
                "Updated XML name".to_string(),
                1,
                "{\"match\":\"all\"}".to_string()
            )
        );
    }

    #[test]
    fn finish_import_relinks_orphan_analysis_to_remapped_track() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, file_exists)
                 VALUES (5, 'LOCAL00000000000', 'App track', 1)",
                [],
            )
            .unwrap();
        db.upsert_analysis("XML0000000000000", &analysis(99, 128.5))
            .unwrap();

        db.begin_import().unwrap();
        let track_id_map = merge_tracks(&db, &[raw_track(5, "XML0000000000000")]);
        db.finish_import().unwrap();

        assert_eq!(track_id_map.get(&5), Some(&6));
        let analysis_track_id: i64 = db
            .conn
            .query_row(
                "SELECT track_id FROM track_analysis WHERE persistent_id = 'XML0000000000000'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(analysis_track_id, 6);
        assert_eq!(db.get_analysis(6).unwrap().unwrap().bpm, Some(128.5));
    }

    #[test]
    fn empty_database_imports_xml_owned_and_app_owned_fields() {
        let db = Database::open_memory().unwrap();
        let mut raw = named_track(4, "INITIAL000000000", "Initial", "2026-01-01T00:00:00Z");
        raw.fields.insert("Rating".to_string(), PlistValue::Int(60));
        raw.fields
            .insert("Play Count".to_string(), PlistValue::Int(12));
        raw.fields
            .insert("Skip Count".to_string(), PlistValue::Int(2));
        raw.fields
            .insert("Disabled".to_string(), PlistValue::Bool(true));
        raw.fields.insert(
            "Play Date UTC".to_string(),
            PlistValue::Date("2026-01-02T00:00:00Z".to_string()),
        );

        db.begin_import().unwrap();
        merge_tracks(&db, &[raw]);
        db.finish_import().unwrap();

        let imported: (i64, i64, i64, i64, String) = db
            .conn
            .query_row(
                "SELECT rating, play_count, skip_count, disabled, last_played
                 FROM tracks WHERE track_id = 4",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(imported, (60, 12, 2, 1, "2026-01-02T00:00:00Z".to_string()));
    }

    #[test]
    fn merge_keeps_organized_local_location() {
        let db = Database::open_memory().unwrap();
        let temp_dir = tempfile::tempdir().unwrap();
        let local_path = temp_dir.path().join("organized-song.mp3");
        std::fs::write(&local_path, b"test").unwrap();
        let local_path = local_path.to_string_lossy().to_string();
        let local_url = format!("file://{local_path}");
        db.conn
            .execute(
                "INSERT INTO tracks
                 (track_id, persistent_id, name, date_modified, location_raw, location_path, file_exists)
                 VALUES (1, 'LOCATION00000001', 'Track', '2026-01-01T00:00:00Z', ?1, ?2, 0)",
                rusqlite::params![local_url, local_path],
            )
            .unwrap();
        let mut incoming = named_track(1, "LOCATION00000001", "Track", "2026-02-01T00:00:00Z");
        incoming.fields.insert(
            "Location".to_string(),
            PlistValue::Str("file:///xml/song.mp3".to_string()),
        );
        db.begin_import().unwrap();
        let mut seen = HashSet::new();
        let mut claimed = HashSet::new();
        db.insert_track(&incoming, "/xml/song.mp3", false, &mut seen, &mut claimed)
            .unwrap();
        db.finish_import().unwrap();

        let location: (String, String, i64) = db
            .conn
            .query_row(
                "SELECT location_raw, location_path, file_exists
                 FROM tracks WHERE persistent_id = 'LOCATION00000001'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(location, (local_url, local_path, 1));
    }

    #[test]
    fn merge_adopts_xml_location_when_local_file_is_gone() {
        let db = Database::open_memory().unwrap();
        let temp_dir = tempfile::tempdir().unwrap();
        let missing_path = temp_dir.path().join("gone.mp3");
        db.conn
            .execute(
                "INSERT INTO tracks
                 (track_id, persistent_id, name, date_modified, location_raw, location_path, file_exists)
                 VALUES (1, 'LOCATION00000002', 'Track', '2026-01-01T00:00:00Z',
                         'file:///old/gone.mp3', ?1, 1)",
                [missing_path.to_string_lossy().as_ref()],
            )
            .unwrap();
        let mut incoming = named_track(1, "LOCATION00000002", "Track", "2026-02-01T00:00:00Z");
        incoming.fields.insert(
            "Location".to_string(),
            PlistValue::Str("file:///xml/new-song.mp3".to_string()),
        );
        db.begin_import().unwrap();
        let mut seen = HashSet::new();
        let mut claimed = HashSet::new();
        db.insert_track(
            &incoming,
            "/xml/new-song.mp3",
            false,
            &mut seen,
            &mut claimed,
        )
        .unwrap();
        db.finish_import().unwrap();

        let location: (String, String, i64) = db
            .conn
            .query_row(
                "SELECT location_raw, location_path, file_exists
                 FROM tracks WHERE persistent_id = 'LOCATION00000002'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            location,
            (
                "file:///xml/new-song.mp3".to_string(),
                "/xml/new-song.mp3".to_string(),
                0,
            )
        );
    }

    #[test]
    fn reimport_missing_pid_track_uses_location_without_growing() {
        let db = Database::open_memory().unwrap();
        for _ in 0..2 {
            let mut raw = RawTrack::default();
            raw.fields
                .insert("Track ID".to_string(), PlistValue::Int(1));
            raw.fields.insert(
                "Location".to_string(),
                PlistValue::Str("file:///music/no-pid.mp3".to_string()),
            );
            db.begin_import().unwrap();
            let mut persistent_ids = HashSet::new();
            let mut claimed_ids = HashSet::new();
            db.insert_track(
                &raw,
                "/music/no-pid.mp3",
                false,
                &mut persistent_ids,
                &mut claimed_ids,
            )
            .unwrap();
            db.finish_import().unwrap();
        }

        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn reimport_duplicate_pid_tracks_claim_distinct_locations_without_growing() {
        let db = Database::open_memory().unwrap();
        for _ in 0..2 {
            db.begin_import().unwrap();
            let mut persistent_ids = HashSet::new();
            let mut claimed_ids = HashSet::new();
            for (track_id, location) in [
                (1, "file:///music/duplicate-a.mp3"),
                (2, "file:///music/duplicate-b.mp3"),
            ] {
                let mut raw = raw_track(track_id, "DUPLICATEPID0001");
                raw.fields.insert(
                    "Location".to_string(),
                    PlistValue::Str(location.to_string()),
                );
                db.insert_track(
                    &raw,
                    &location["file://".len()..],
                    false,
                    &mut persistent_ids,
                    &mut claimed_ids,
                )
                .unwrap();
            }
            db.finish_import().unwrap();
        }

        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn reimport_degenerate_playlists_uses_name_and_parent_without_growing() {
        let db = Database::open_memory().unwrap();
        for _ in 0..2 {
            db.begin_import().unwrap();
            let mut persistent_ids = HashSet::new();
            let mut claimed_ids = HashSet::new();
            let track_id_map = HashMap::new();

            let mut missing_pid = RawPlaylist::default();
            missing_pid
                .fields
                .insert("Playlist ID".to_string(), PlistValue::Int(10));
            missing_pid
                .fields
                .insert("Name".to_string(), PlistValue::Str("No PID".to_string()));
            db.insert_playlist(
                &missing_pid,
                0,
                &track_id_map,
                &mut persistent_ids,
                &mut claimed_ids,
            )
            .unwrap();

            for (playlist_id, name) in [(11, "Duplicate A"), (12, "Duplicate B")] {
                let raw = raw_playlist(playlist_id, "DUPPLAYLIST00001", name, vec![]);
                db.insert_playlist(
                    &raw,
                    playlist_id,
                    &track_id_map,
                    &mut persistent_ids,
                    &mut claimed_ids,
                )
                .unwrap();
            }
            db.finish_import().unwrap();
        }

        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM playlists", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn import_generates_missing_and_duplicate_persistent_ids() {
        let db = Database::open_memory().unwrap();
        db.begin_import().unwrap();
        let mut imported_track_ids = HashSet::new();
        let mut claimed_track_ids = HashSet::new();

        for (track_id, persistent_id) in [
            (1, Some("ABCDEF0123456789")),
            (2, Some("ABCDEF0123456789")),
            (3, Some("")),
            (4, None),
        ] {
            let mut raw = RawTrack::default();
            raw.fields
                .insert("Track ID".to_string(), PlistValue::Int(track_id));
            if let Some(persistent_id) = persistent_id {
                raw.fields.insert(
                    "Persistent ID".to_string(),
                    PlistValue::Str(persistent_id.to_string()),
                );
            }
            db.insert_track(
                &raw,
                "",
                true,
                &mut imported_track_ids,
                &mut claimed_track_ids,
            )
            .unwrap();
        }

        let track_id_map = HashMap::new();
        let mut imported_playlist_ids = HashSet::new();
        let mut claimed_playlist_ids = HashSet::new();
        for (playlist_id, persistent_id) in [
            (10, Some("1234567890ABCDEF")),
            (11, Some("1234567890ABCDEF")),
            (12, Some("")),
            (13, None),
        ] {
            let mut raw = RawPlaylist::default();
            raw.fields
                .insert("Playlist ID".to_string(), PlistValue::Int(playlist_id));
            raw.fields.insert(
                "Name".to_string(),
                PlistValue::Str(format!("playlist {playlist_id}")),
            );
            if let Some(persistent_id) = persistent_id {
                raw.fields.insert(
                    "Playlist Persistent ID".to_string(),
                    PlistValue::Str(persistent_id.to_string()),
                );
            }
            db.insert_playlist(
                &raw,
                playlist_id,
                &track_id_map,
                &mut imported_playlist_ids,
                &mut claimed_playlist_ids,
            )
            .unwrap();
        }
        db.finish_import().unwrap();

        assert_non_empty_unique_ids(&db.conn, "tracks", 4);
        assert_non_empty_unique_ids(&db.conn, "playlists", 4);
        let first_track: String = db
            .conn
            .query_row(
                "SELECT persistent_id FROM tracks WHERE track_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first_track, "ABCDEF0123456789");
        let first_playlist: String = db
            .conn
            .query_row(
                "SELECT persistent_id FROM playlists WHERE playlist_id = 10",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first_playlist, "1234567890ABCDEF");
    }
}
