//! メタデータ編集後の「整理 (フォルダ分け + リネーム) と DB location 追従」。
//!
//! GUI の `update_track` コマンドと HTTP API の `PATCH /api/tracks[/:id]` の両方が
//! この関数を通すことで、編集時のファイル移動の挙動が食い違わないようにする。
//! (以前は API 側だけ移動処理が抜けており、`Unknown Artist/Unknown Album/` に
//! 取り残されたままになっていた。)
//!
//! 親モジュール (`organizer`) は DB 非依存だが、ここは DB の location 更新まで
//! 一括で行うため `Database` に依存する。

use std::path::Path;

use crate::db::Database;
use crate::itunes_xml::writer;

use super::{organize_target, relocate, Mode, TrackMeta};

/// 編集後の整理の結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelocateOutcome {
    /// 整理対象外 (整理先ルート未設定 / 整理無効 / location 無し / 実ファイル無し)。
    Skipped,
    /// 整理を試みたが既に規則どおりの位置にあり、移動しなかった。
    Unchanged,
    /// 移動した。DB に書いた新しい `location_path` / `location_raw` (`file://` URI)。
    Moved { path: String, url: String },
    /// 移動に失敗した (編集自体は成功扱い。理由は eprintln 済み、呼び出し側は警告に留める)。
    Failed,
}

/// 編集確定後のメタデータ `meta` に従い、`loc` の実ファイルを整理先へ移動して
/// DB の location (`location_path` / `location_raw`) を追従させる。
///
/// - `db.organize_root()` が `None` (ルート未設定 / `organize_enabled == "0"`) なら移動しない。
/// - 移動失敗は `Ok(Failed)` で返し、eprintln で記録する (GUI の従来挙動と同じ)。
/// - 移動後の DB 更新失敗だけは `Err` (ファイルと DB の不整合になるため呼び出し側へ伝える)。
pub fn relocate_after_edit(
    db: &Database,
    track_id: i64,
    loc: Option<&str>,
    meta: &TrackMeta,
) -> rusqlite::Result<RelocateOutcome> {
    let Some(loc) = loc else {
        return Ok(RelocateOutcome::Skipped);
    };
    let src = Path::new(loc);
    if !src.exists() {
        return Ok(RelocateOutcome::Skipped);
    }
    let Some(target) = organize_target(db.organize_root().as_deref(), meta, src) else {
        return Ok(RelocateOutcome::Skipped);
    };
    // 新ターゲットへ移動し、DB の location を追従させる。
    match relocate(src, &target, Mode::Move) {
        Ok(dest) if dest != src => {
            let dest_str = dest.to_string_lossy().to_string();
            let url = writer::path_to_file_url(&dest_str);
            db.set_track_location(track_id, &dest_str, &url)?;
            Ok(RelocateOutcome::Moved { path: dest_str, url })
        }
        Ok(_) => Ok(RelocateOutcome::Unchanged),
        Err(e) => {
            eprintln!("relocate failed for {}: {}", loc, e);
            Ok(RelocateOutcome::Failed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_track(db: &Database, track_id: i64, path: &str) {
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, location_path, location_raw) \
                 VALUES (?1, 't', ?2, ?2)",
                rusqlite::params![track_id, path],
            )
            .unwrap();
    }

    fn location_of(db: &Database, track_id: i64) -> String {
        db.conn
            .query_row(
                "SELECT location_path FROM tracks WHERE track_id = ?1",
                rusqlite::params![track_id],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn meta() -> TrackMeta<'static> {
        TrackMeta {
            title: Some("Song"),
            artist: Some("Artist"),
            album_artist: None,
            album: Some("Album"),
            compilation: false,
            track_number: Some(3),
            disc_number: None,
            disc_count: None,
        }
    }

    /// `Unknown Artist/Unknown Album/` に置かれたファイルを、編集後のメタデータで整理する。
    fn setup() -> (tempfile::TempDir, Database, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let src_dir = dir.path().join("Unknown Artist").join("Unknown Album");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("01 Track 01.mp3");
        std::fs::write(&src, b"dummy").unwrap();
        let db = Database::open_memory().unwrap();
        insert_track(&db, 1, &src.to_string_lossy());
        (dir, db, src)
    }

    #[test]
    fn moves_file_and_updates_db_location_when_root_set() {
        let (dir, db, src) = setup();
        db.set_state("library_root", &dir.path().to_string_lossy()).unwrap();

        let out = relocate_after_edit(&db, 1, src.to_str(), &meta()).unwrap();
        let expected = dir.path().join("Artist").join("Album").join("03 Song.mp3");
        let expected_str = expected.to_string_lossy().to_string();
        assert_eq!(
            out,
            RelocateOutcome::Moved {
                url: writer::path_to_file_url(&expected_str),
                path: expected_str,
            }
        );
        assert!(expected.exists());
        assert!(!src.exists());
        assert_eq!(location_of(&db, 1), expected.to_string_lossy());

        // 2 回目は既に規則どおりの位置なので移動しない。
        let again = relocate_after_edit(&db, 1, expected.to_str(), &meta()).unwrap();
        assert_eq!(again, RelocateOutcome::Unchanged);
    }

    #[test]
    fn skips_when_root_unset_or_disabled() {
        let (dir, db, src) = setup();
        let loc = src.to_string_lossy().to_string();

        // ルート未設定。
        assert_eq!(
            relocate_after_edit(&db, 1, Some(loc.as_str()), &meta()).unwrap(),
            RelocateOutcome::Skipped
        );
        // ルート設定済みでも organize_enabled == "0" なら移動しない。
        db.set_state("library_root", &dir.path().to_string_lossy()).unwrap();
        db.set_state("organize_enabled", "0").unwrap();
        assert_eq!(
            relocate_after_edit(&db, 1, Some(loc.as_str()), &meta()).unwrap(),
            RelocateOutcome::Skipped
        );
        assert!(src.exists());
        assert_eq!(location_of(&db, 1), loc);
    }

    #[test]
    fn skips_missing_location_or_file() {
        let (dir, db, _src) = setup();
        db.set_state("library_root", &dir.path().to_string_lossy()).unwrap();
        assert_eq!(
            relocate_after_edit(&db, 1, None, &meta()).unwrap(),
            RelocateOutcome::Skipped
        );
        let missing = dir.path().join("nope.mp3");
        assert_eq!(
            relocate_after_edit(&db, 1, missing.to_str(), &meta()).unwrap(),
            RelocateOutcome::Skipped
        );
    }
}
