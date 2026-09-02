//! `library.db` のバックアップ / 整合性チェック / 最適化 (#167)。
//!
//! 解析結果・スキップ数・スマートプレイリスト条件・同期状態など、XML 自動
//! エクスポートではカバーされないデータが `library.db` にしか無いため、DB 自体の
//! バックアップ手段を用意する。`VACUUM INTO` は WAL モードでも安全に一貫した
//! スナップショットを取れる (読み取り専用トランザクション相当)。

use std::path::Path;

use rusqlite::{Connection, OpenFlags, Result};

use super::Database;

impl Database {
    /// 現在の DB を `path` へ一貫性のあるスナップショットとして書き出す。
    /// `VACUUM INTO` は出力先が既に存在すると失敗するため、事前に削除しておく。
    /// 出力ファイルは常にロールバックジャーナルモードになり、-wal/-shm は
    /// 生成されない (元の DB が WAL でも影響しない)。
    pub fn backup_to(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::remove_file(path);
        let path_str = path.to_string_lossy().into_owned();
        self.conn
            .execute("VACUUM INTO ?1", rusqlite::params![path_str])?;
        Ok(())
    }

    /// `PRAGMA integrity_check` を実行し、結果行をそのまま返す。
    /// 健全なら `["ok"]` の 1 行だけが返る。
    pub fn integrity_check(&self) -> Result<Vec<String>> {
        integrity_check_conn(&self.conn)
    }

    /// DB ファイルを最適化する (デッドページ回収 + ファイル再編成)。
    pub fn vacuum(&self) -> Result<()> {
        self.conn.execute("VACUUM", [])?;
        Ok(())
    }
}

fn integrity_check_conn(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA integrity_check")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// 任意パスの SQLite ファイルを読み取り専用で開いて整合性チェックする。
/// 復元前のバックアップファイル検証に使う。読み取り専用で開くため
/// -wal/-shm を作らず、元ファイルを一切変更しない。
pub fn check_integrity_at(path: &Path) -> Result<Vec<String>> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    integrity_check_conn(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn backup_to_creates_consistent_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        db.set_state("foo", "bar").unwrap();

        let backup_path = dir.path().join("backups/library-test.db");
        db.backup_to(&backup_path).unwrap();
        assert!(backup_path.is_file());

        // バックアップ先は健全な単体 DB として整合性チェックを通る。
        let rows = check_integrity_at(&backup_path).unwrap();
        assert_eq!(rows, vec!["ok".to_string()]);

        // データも引き継がれている。
        let conn = Connection::open_with_flags(&backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM app_state WHERE key = 'foo'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "bar");
    }

    #[test]
    fn backup_to_overwrites_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        let backup_path = dir.path().join("dup.db");
        db.backup_to(&backup_path).unwrap();
        // 2 回目も (出力先が既に存在していても) 成功する。
        db.backup_to(&backup_path).unwrap();
        assert!(backup_path.is_file());
    }

    #[test]
    fn integrity_check_reports_ok_for_healthy_db() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        assert_eq!(db.integrity_check().unwrap(), vec!["ok".to_string()]);
    }

    #[test]
    fn vacuum_runs_without_error_and_stays_healthy() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        db.set_state("k", "v").unwrap();
        db.vacuum().unwrap();
        assert_eq!(db.integrity_check().unwrap(), vec!["ok".to_string()]);
        assert_eq!(db.get_state("k").unwrap(), Some("v".to_string()));
    }

    #[test]
    fn check_integrity_at_detects_non_database_file() {
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("not-a-db.db");
        std::fs::write(&bogus, b"this is not a sqlite file at all, just plain bytes").unwrap();
        // ヘッダ不正なファイルは integrity_check 自体がエラーを返す (open は
        // 遅延評価なので、実際に読みに行く prepare/query の段階で失敗する)。
        assert!(check_integrity_at(&bogus).is_err());
    }
}
