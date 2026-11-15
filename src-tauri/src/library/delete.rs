//! 曲をライブラリから取り除く。
//!
//! トラック行を消す経路は 2 つある: ここ ([`remove_tracks`]。ユーザーの「削除」) と、
//! 同期の退避 (`sync::evict`)。どちらも DB の行は `db::tracks::delete_track_cascade` で消し、
//! **消えた曲の track_id を呼び出し元へ返す**。
//!
//! 行が消えた曲は再生キュー・再生中の曲にも残してはいけない (再生実績を書く先が無く、
//! UI は存在しない曲を指し続ける)。再生系は `AppHandle` に載っているのでこの層からは触れない。
//! **返された id で `commands::playback::drop_tracks_from_playback` を呼ぶのはアダプタの責務**。

use std::fmt;
use std::path::{Path, PathBuf};

use crate::db::Database;

/// [`remove_tracks`] の失敗。どれも「何も消していない」状態で返る。
#[derive(Debug)]
pub enum DeleteError {
    /// ファイルも消す指定なのに、ライブラリルート (整理先) が未設定。
    LibraryRootNotSet,
    /// ライブラリルートのパスを解決できない (存在しない等)。
    LibraryRootUnresolvable {
        root: String,
        source: std::io::Error,
    },
    /// 削除対象ファイルのパスを解決できない。
    FileUnresolvable {
        file: PathBuf,
        source: std::io::Error,
    },
    /// 削除対象ファイルがライブラリルートの外にある。
    FileOutsideLibraryRoot { file: PathBuf, root: PathBuf },
    /// DB の読み書きに失敗した。
    Db(rusqlite::Error),
}

impl fmt::Display for DeleteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DeleteError::LibraryRootNotSet => f.write_str(
                "ファイルを削除するにはライブラリルート (整理先) の設定が必要です。\
                 設定でルートを指定するか、ライブラリ (DB) からの削除だけを行ってください。",
            ),
            DeleteError::LibraryRootUnresolvable { root, source } => write!(
                f,
                "ライブラリルート ({root}) を解決できませんでした: {source}"
            ),
            DeleteError::FileUnresolvable { file, source } => write!(
                f,
                "{} のパスを解決できませんでした: {}",
                file.display(),
                source
            ),
            DeleteError::FileOutsideLibraryRoot { file, root } => write!(
                f,
                "{} はライブラリルート ({}) の外にあるため、安全のためファイルを削除しません。\
                 「ファイルも削除する」のチェックを外せば、ライブラリ (DB) からの削除だけを行えます。",
                file.display(),
                root.display()
            ),
            DeleteError::Db(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for DeleteError {}

impl From<rusqlite::Error> for DeleteError {
    fn from(e: rusqlite::Error) -> Self {
        DeleteError::Db(e)
    }
}

/// ライブラリから消えた曲。呼び出し元 (アダプタ) はこの id を再生系から落とすこと。
#[derive(Debug, Clone, Default)]
#[must_use = "消えた曲は再生キューからも落とす (commands::playback::drop_tracks_from_playback)"]
pub struct RemovedTracks {
    /// 実際に DB から消えた曲の track_id (存在しなかった id・重複は含まない)。
    pub track_ids: Vec<i64>,
}

/// 削除対象の実ファイルが「整理ルート配下」にあることを検証し、正規化パスを返す。
///
/// `trash` クレートを依存に持たないため OS のゴミ箱へは送れず、削除は復元不能になる。
/// そのためアプリが管理するライブラリルート配下に限って実削除を許可し、
/// それ以外 (外部参照のファイル) は消さずにエラーで返す。
/// symlink でルート外を指すファイルも弾けるよう、両者 canonicalize してから比較する
/// (`root` は canonicalize 済みを渡す)。
fn ensure_inside_root(root: &Path, file: &Path) -> Result<PathBuf, DeleteError> {
    let canonical =
        std::fs::canonicalize(file).map_err(|source| DeleteError::FileUnresolvable {
            file: file.to_path_buf(),
            source,
        })?;
    if !canonical.starts_with(root) {
        return Err(DeleteError::FileOutsideLibraryRoot {
            file: file.to_path_buf(),
            root: root.to_path_buf(),
        });
    }
    Ok(canonical)
}

/// 指定トラックをライブラリから削除する。
///
/// - DB からはトラック行と依存行 (プレイリスト所属 / 再生履歴 / 解析結果 / 同期メタ) を
///   1 トランザクションで消す。存在しない id は無視する。
/// - `delete_files` が true のときだけ実ファイルも削除する。ゴミ箱へ送れないため
///   ライブラリルート配下のファイルに限定し、1 件でもルート外があれば **何も消さずに** エラー。
///   既に存在しないファイルは検証せず DB の掃除だけ行う。
/// - ファイル削除の個別の失敗 (権限など) は警告ログに留め、DB 側の削除は確定させる。
pub fn remove_tracks(
    db: &Database,
    track_ids: &[i64],
    delete_files: bool,
) -> Result<RemovedTracks, DeleteError> {
    // 1. ファイル削除は「全件検証 → まとめて実行」にして、途中失敗で
    //    DB とファイルがちぐはぐになるのを防ぐ。
    let mut files: Vec<PathBuf> = Vec::new();
    if delete_files {
        let root = db.organize_root().ok_or(DeleteError::LibraryRootNotSet)?;
        let root = std::fs::canonicalize(&root)
            .map_err(|source| DeleteError::LibraryRootUnresolvable { root, source })?;
        for track in db.get_tracks_by_ids(track_ids)? {
            let Some(loc) = track.location_path.filter(|p| !p.is_empty()) else {
                continue;
            };
            let path = Path::new(&loc);
            if !path.exists() {
                continue;
            }
            files.push(ensure_inside_root(&root, path)?);
        }
    }

    // 2. DB から削除 (1 トランザクション)。
    let removed = RemovedTracks {
        track_ids: db.delete_tracks(track_ids)?,
    };

    // 3. 検証済みファイルを削除する。再試行しても DB に行は残っていないので、失敗は警告に留める。
    for path in files {
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("remove_file failed for {}: {}", path.display(), e);
            crate::logging::write_line(
                "warn",
                &format!("failed to delete file {}: {}", path.display(), e),
            );
        }
    }

    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_track(db: &Database, track_id: i64, path: Option<&Path>) {
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, location_path, file_exists)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                rusqlite::params![
                    track_id,
                    format!("{track_id:016X}"),
                    format!("T{track_id}"),
                    path.map(|p| p.to_string_lossy().to_string()),
                ],
            )
            .unwrap();
    }

    fn remaining(db: &Database) -> Vec<i64> {
        db.get_all_tracks()
            .unwrap()
            .into_iter()
            .map(|t| t.track_id)
            .collect()
    }

    /// DB だけの削除: 消えた id だけを返す (存在しない id・重複は含まない)。ファイルは残す。
    #[test]
    fn removes_rows_and_reports_removed_ids() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.mp3");
        std::fs::write(&file, b"x").unwrap();
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, Some(&file));
        add_track(&db, 2, None);
        add_track(&db, 3, None);

        let removed = remove_tracks(&db, &[1, 999, 2, 1], false).unwrap();
        assert_eq!(removed.track_ids, vec![1, 2]);
        assert_eq!(remaining(&db), vec![3]);
        assert!(file.exists(), "delete_files=false ではファイルに触らない");

        assert!(remove_tracks(&db, &[], false).unwrap().track_ids.is_empty());
    }

    /// ファイルも消す: ライブラリルート配下のファイルだけを消す。無いファイルは DB の掃除だけ。
    #[test]
    fn deletes_files_inside_library_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Music");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("a.mp3");
        std::fs::write(&inside, b"x").unwrap();
        let gone = root.join("gone.mp3");
        let db = Database::open_memory().unwrap();
        db.set_state("library_root", &root.to_string_lossy())
            .unwrap();
        add_track(&db, 1, Some(&inside));
        add_track(&db, 2, Some(&gone));

        let removed = remove_tracks(&db, &[1, 2], true).unwrap();
        assert_eq!(removed.track_ids, vec![1, 2]);
        assert!(!inside.exists());
        assert!(remaining(&db).is_empty());
    }

    /// 1 件でもルート外のファイルがあれば、DB もファイルも何も消さない。
    #[test]
    fn outside_root_aborts_everything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Music");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("a.mp3");
        let outside = dir.path().join("elsewhere.mp3");
        std::fs::write(&inside, b"x").unwrap();
        std::fs::write(&outside, b"x").unwrap();
        let db = Database::open_memory().unwrap();
        db.set_state("library_root", &root.to_string_lossy())
            .unwrap();
        add_track(&db, 1, Some(&inside));
        add_track(&db, 2, Some(&outside));

        let err = remove_tracks(&db, &[1, 2], true).unwrap_err();
        assert!(
            matches!(err, DeleteError::FileOutsideLibraryRoot { .. }),
            "{err:?}"
        );
        assert!(err.to_string().contains("の外にあるため"));
        assert!(inside.exists() && outside.exists());
        assert_eq!(remaining(&db), vec![1, 2]);
    }

    /// ファイルも消す指定でルート未設定ならエラー (DB も消さない)。
    #[test]
    fn delete_files_requires_library_root() {
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, None);
        let err = remove_tracks(&db, &[1], true).unwrap_err();
        assert!(matches!(err, DeleteError::LibraryRootNotSet), "{err:?}");
        assert_eq!(remaining(&db), vec![1]);
    }
}
