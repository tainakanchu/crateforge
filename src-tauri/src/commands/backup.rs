//! `library.db` のバックアップ / 復元 / 整合性チェック / VACUUM コマンド (#167)。
//!
//! このアプリの各コマンドはリクエストの度に `Database::open` して都度クローズする
//! 設計 (常時保持されたコネクションは無い) なので、復元時に「共有コネクションを
//! 差し替える」必要は無い。DB ファイルそのものを入れ替えれば、以後のコマンドは
//! 自然に新しい内容を読む。ただし `ValidTokens` など DB から起動時に一度だけ
//! 読み込んでメモリに保持する状態があるため、復元後はアプリの再起動を要する。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::db::backup::check_integrity_at;
use crate::db::Database;

/// 自動ローテーションで残すバックアップ件数の既定値。
const DEFAULT_KEEP: usize = 5;
/// 自動バックアップ (dest 未指定) の最短間隔 (秒)。直近のバックアップがこれより
/// 新しければ何もせずスキップする ("軽く" 保つため)。
const AUTO_BACKUP_MIN_INTERVAL_SECS: u64 = 30 * 60;

fn get_db(app: &AppHandle) -> Result<Database, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Database::open(&app_dir).map_err(|e| format!("Failed to open database: {}", e))
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(app_dir.join("backups"))
}

/// `<dir>/library-*.db` を新しい順 (ファイル名 = タイムスタンプの降順) に列挙する。
/// ファイル名の書式 `library-YYYYMMDD-HHMMSS.db` は辞書順ソートがそのまま時系列
/// 降順になるので、mtime ではなく文字列ソートで十分。
fn list_backups(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("library-") && n.ends_with(".db"))
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    entries.reverse();
    entries
}

/// 保持件数 (`keep`) を超えた古いバックアップを削除する。
fn rotate_backups(dir: &Path, keep: usize) {
    for old in list_backups(dir).into_iter().skip(keep) {
        let _ = std::fs::remove_file(old);
    }
}

fn seconds_since_modified(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now()
        .duration_since(modified)
        .ok()
        .map(|d| d.as_secs())
}

/// `library.db` をバックアップする。`dest` を指定すればそこへ直接書き出す
/// (ユーザーが「今すぐバックアップ」で明示的に選んだ先など)。
/// `dest` 省略時は `<app data dir>/backups/library-YYYYMMDD-HHMMSS.db` に
/// 書き出し、直近 [`DEFAULT_KEEP`] 件だけ残してローテーションする。ただし
/// 直近のバックアップが [`AUTO_BACKUP_MIN_INTERVAL_SECS`] 未満しか経っていなければ
/// 何もせず、その既存バックアップのパスを返す (自動バックアップを軽く保つため)。
#[tauri::command]
pub fn backup_library(app: AppHandle, dest: Option<String>) -> Result<String, String> {
    let db = get_db(&app)?;
    match dest {
        Some(d) => {
            let path = PathBuf::from(&d);
            db.backup_to(&path)
                .map_err(|e| format!("バックアップに失敗しました: {}", e))?;
            Ok(d)
        }
        None => {
            let dir = backups_dir(&app)?;
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("バックアップ先の作成に失敗しました: {}", e))?;

            if let Some(newest) = list_backups(&dir).first() {
                if let Some(age) = seconds_since_modified(newest) {
                    if age < AUTO_BACKUP_MIN_INTERVAL_SECS {
                        return Ok(newest.to_string_lossy().into_owned());
                    }
                }
            }

            let filename = format!(
                "library-{}.db",
                chrono::Local::now().format("%Y%m%d-%H%M%S")
            );
            let path = dir.join(filename);
            db.backup_to(&path)
                .map_err(|e| format!("バックアップに失敗しました: {}", e))?;
            rotate_backups(&dir, DEFAULT_KEEP);
            Ok(path.to_string_lossy().into_owned())
        }
    }
}

/// バックアップファイル (`src`) を検証してから `library.db` を置き換える。
/// 戻り値 `true` は「アプリの再起動が必要」を示す (このアプリはトークン等の
/// 一部状態を起動時に DB から読み込んでメモリに保持するため、DB を差し替えた
/// だけでは反映されない箇所がある。安全側に倒して常に再起動を促す)。
#[tauri::command]
pub fn restore_library(app: AppHandle, src: String) -> Result<bool, String> {
    let src_path = PathBuf::from(&src);
    if !src_path.is_file() {
        return Err("バックアップファイルが見つかりません".to_string());
    }

    // 1. 復元元の整合性を先に検証する (壊れたファイルで上書きしないため)。
    let rows = check_integrity_at(&src_path)
        .map_err(|e| format!("バックアップを開けませんでした: {}", e))?;
    if rows != vec!["ok".to_string()] {
        return Err(format!(
            "バックアップの整合性チェックに失敗しました: {}",
            rows.join("; ")
        ));
    }

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    let live_path = app_dir.join("library.db");

    // 2. 生きている DB への接続は各コマンドが都度 open/close する設計で、常時
    //    保持されたコネクションは無い。念のため WAL を本体ファイルへ畳んでから
    //    (これから置き換える本体に古い -wal が追記されるのを避ける) すぐ閉じる。
    if live_path.exists() {
        if let Ok(live) = Connection::open(&live_path) {
            let _ = live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
    }

    // 3. 一時ファイルへコピーしてから同一ディレクトリ内でリネームし、
    //    本体の置き換えを (ほぼ) アトミックにする。
    let tmp_path = app_dir.join("library.db.restoring");
    std::fs::copy(&src_path, &tmp_path)
        .map_err(|e| format!("バックアップのコピーに失敗しました: {}", e))?;
    std::fs::rename(&tmp_path, &live_path)
        .map_err(|e| format!("ライブラリの置き換えに失敗しました: {}", e))?;

    // 4. 置き換えた本体に対応する古い -wal/-shm が残っていれば破棄する。
    let _ = std::fs::remove_file(app_dir.join("library.db-wal"));
    let _ = std::fs::remove_file(app_dir.join("library.db-shm"));

    Ok(true)
}

/// 現在の `library.db` の整合性チェック結果を返す。`["ok"]` なら健全。
#[tauri::command]
pub fn check_library_integrity(app: AppHandle) -> Result<Vec<String>, String> {
    let db = get_db(&app)?;
    db.integrity_check().map_err(|e| e.to_string())
}

/// 現在の `library.db` を VACUUM で最適化する。
#[tauri::command]
pub fn vacuum_library(app: AppHandle) -> Result<(), String> {
    let db = get_db(&app)?;
    db.vacuum().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rotate_backups_keeps_only_newest_n() {
        let dir = tempfile::tempdir().unwrap();
        for day in 1..=7 {
            let name = format!("library-202601{:02}-000000.db", day);
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        rotate_backups(dir.path(), 5);
        let remaining = list_backups(dir.path());
        assert_eq!(remaining.len(), 5);
        // 新しい順: 07, 06, 05, 04, 03 (01, 02 は削除される)。
        assert!(remaining[0].to_string_lossy().contains("20260107"));
        assert!(remaining[4].to_string_lossy().contains("20260103"));
        assert!(!dir.path().join("library-20260101-000000.db").exists());
        assert!(!dir.path().join("library-20260102-000000.db").exists());
    }

    #[test]
    fn list_backups_ignores_non_matching_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("library-20260101-000000.db"), b"x").unwrap();
        fs::write(dir.path().join("other.txt"), b"x").unwrap();
        // ライブラリ本体 (ダッシュ無し) はローテーション対象に含めない。
        fs::write(dir.path().join("library.db"), b"x").unwrap();
        let found = list_backups(dir.path());
        assert_eq!(found.len(), 1);
        assert!(found[0].to_string_lossy().contains("20260101"));
    }

    #[test]
    fn backup_and_restore_round_trip_via_database_api() {
        // AppHandle 無しで db 層を直接叩いて、コマンドが呼ぶロジックの結合を検証する。
        let live_dir = tempfile::tempdir().unwrap();
        let db = Database::open(live_dir.path()).unwrap();
        db.set_state("marker", "hello").unwrap();

        let backup_dir = tempfile::tempdir().unwrap();
        let backup_path = backup_dir.path().join("library-20260101-000000.db");
        db.backup_to(&backup_path).unwrap();

        let rows = check_integrity_at(&backup_path).unwrap();
        assert_eq!(rows, vec!["ok".to_string()]);

        // 復元 = 単純なファイル置き換えなので、DB を閉じたうえでコピーする。
        drop(db);
        let live_path = live_dir.path().join("library.db");
        fs::copy(&backup_path, &live_path).unwrap();

        let restored = Database::open(live_dir.path()).unwrap();
        assert_eq!(
            restored.get_state("marker").unwrap(),
            Some("hello".to_string())
        );
    }
}
