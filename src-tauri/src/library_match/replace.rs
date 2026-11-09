//! 既存曲を新しいファイルへ置き換える共通処理 (CD リッピング / ファイル取り込み共用)。
//!
//! 呼び出し側が新しいファイル (エンコード結果 / 整理先へのコピー) を用意したあと、
//! [`finalize_replacement`] が次を行う:
//!
//! 1. 既存行のメタデータ (ユーザー編集が優先) を新ファイルのタグへ書く。
//! 2. 旧ファイルのアートワークが読めれば新ファイルへ埋め込む。
//! 3. 新ファイルから長さ・技術メタデータを読む。
//! 4. 旧ファイルは消さずに `_replaced/<YYYYMMDD>/` へ退避する
//!    (他の曲も参照していれば触らない / 無ければ何もしない)。
//! 5. 既存行を 1 トランザクションで新ファイルへ付け替え、解析結果を消す。
//!
//! どこかで失敗したら、自分で作った新ファイルを消し、退避した旧ファイルを戻して
//! 既存行・旧ファイルには手を付けていない状態でエラーを返す。

use std::path::{Path, PathBuf};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use serde::Serialize;

use crate::db::Database;
use crate::itunes_xml::writer::path_to_file_url;
use crate::metadata::tech;
use crate::models::Track;
use crate::organizer;

/// 置き換えた旧ファイルの扱い。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OldFileDisposition {
    /// `_replaced/...` へ退避した。
    Moved { to: String },
    /// 旧ファイルが無かった (何もしていない)。
    Missing,
    /// 他の曲も同じファイルを参照しているので残した。
    KeptShared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceOutcome {
    pub new_path: String,
    pub old_file: OldFileDisposition,
}

/// 置き換え先 (新ファイル) の情報。
pub struct NewFile<'a> {
    /// 用意済みの新ファイル。
    pub path: PathBuf,
    /// 新ファイルをこの処理が作ったか (失敗時に消してよいか)。
    /// その場参照の取り込み (元ファイルそのもの) では false。
    pub owned: bool,
    /// 本来置きたかったパス (衝突回避で ` (2)` が付いた場合、旧ファイル退避後に
    /// 空いていればここへ改名する)。
    pub desired: Option<PathBuf>,
    /// `_replaced` を作る基準 (ライブラリルート)。None なら旧ファイルの隣に作る。
    pub library_root: Option<&'a Path>,
}

/// 既存行のメタデータから整理先 (`<root>/<artist>/<album>/<file>`) を決める。
/// 拡張子は `source` (新ファイル) のものを使う。
pub fn target_for_track(root: &Path, track: &Track, source: &Path) -> PathBuf {
    let meta = organizer::TrackMeta {
        title: track.name.as_deref(),
        artist: track.artist.as_deref(),
        album_artist: track.album_artist.as_deref(),
        album: track.album.as_deref(),
        compilation: track.compilation,
        track_number: track.track_number,
        disc_number: track.disc_number,
        disc_count: track.disc_count,
    };
    organizer::target_path(root, &meta, source)
}

/// 旧ファイルの退避先 `<base>/_replaced/<date>/<root からの相対パス or ファイル名>`。
pub fn replaced_destination(old: &Path, library_root: Option<&Path>, date: &str) -> PathBuf {
    let (base, rel): (PathBuf, PathBuf) = match library_root {
        Some(root) => match old.strip_prefix(root) {
            Ok(rel) => (root.to_path_buf(), rel.to_path_buf()),
            Err(_) => (
                root.to_path_buf(),
                PathBuf::from(old.file_name().unwrap_or_default()),
            ),
        },
        None => (
            old.parent().map(Path::to_path_buf).unwrap_or_default(),
            PathBuf::from(old.file_name().unwrap_or_default()),
        ),
    };
    base.join("_replaced").join(date).join(rel)
}

fn same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    if std::fs::rename(from, to).is_err() {
        std::fs::copy(from, to).map_err(|e| format!("copy failed: {e}"))?;
        if let Err(e) = std::fs::remove_file(from) {
            let _ = std::fs::remove_file(to);
            return Err(format!("remove failed: {e}"));
        }
    }
    Ok(())
}

/// 新ファイルの長さ (ms) と技術メタデータを 1 回の probe で読む。
fn read_duration_and_tech(path: &Path) -> Result<(Option<i64>, tech::TechMeta), String> {
    let size = std::fs::metadata(path).ok().map(|m| m.len());
    let tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {e}"))?
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;
    let props = tagged.properties();
    let ms = props.duration().as_millis() as i64;
    Ok((
        Some(ms).filter(|&m| m > 0),
        tech::from_properties(&tagged.file_type(), props, size),
    ))
}

/// 既存行 `track_id` を `new_file` へ置き換える。詳細はモジュール冒頭を参照。
pub fn finalize_replacement(
    db: &Database,
    track_id: i64,
    new_file: NewFile,
) -> Result<ReplaceOutcome, String> {
    let NewFile {
        path: mut new_path,
        owned,
        desired,
        library_root,
    } = new_file;
    let cleanup = |p: &Path| {
        if owned {
            let _ = std::fs::remove_file(p);
        }
    };

    let track = match db.get_track_by_track_id(track_id) {
        Ok(Some(t)) => t,
        Ok(None) => {
            cleanup(&new_path);
            return Err(format!("置き換え先の曲が見つかりません (id={track_id})"));
        }
        Err(e) => {
            cleanup(&new_path);
            return Err(e.to_string());
        }
    };
    let old_path = track
        .location_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    if let Some(old) = &old_path {
        if same_file(old, &new_path) {
            // ここで処理を続けると旧ファイルを自分で退避してしまう。
            // 呼び出し側が防ぐべきケースなので、新ファイルは消さない。
            return Err("置き換え元と同じファイルです".to_string());
        }
    }
    let old_exists = old_path.as_deref().is_some_and(Path::is_file);

    // 1. 既存行のメタデータを新ファイルのタグへ (ユーザー編集が MB / 元タグより優先)。
    let analysis = db.get_analysis(track_id).ok().flatten();
    let key =
        organizer::effective_initial_key(track.key_camelot_user.as_deref(), analysis.as_ref());
    let w = organizer::TagWrite {
        title: track.name.as_deref(),
        artist: track.artist.as_deref(),
        album_artist: track.album_artist.as_deref(),
        composer: track.composer.as_deref(),
        album: track.album.as_deref(),
        genre: track.genre.as_deref(),
        comments: track.comments.as_deref(),
        year: track.year,
        track_number: track.track_number,
        track_count: track.track_count,
        disc_number: track.disc_number,
        disc_count: track.disc_count,
        compilation: Some(track.compilation),
        bpm: track.bpm.map(|b| b as f64),
        key,
    };
    if let Err(e) = organizer::write_tags(&new_path, &w) {
        cleanup(&new_path);
        return Err(format!("タグを書き込めませんでした: {e}"));
    }

    // 2. アートワーク: 旧ファイルから読めれば引き継ぐ (読めなければ新ファイルのまま)。
    if old_exists {
        let old_str = old_path.as_deref().unwrap().to_string_lossy().to_string();
        if let Some((data, _mime)) = crate::artwork::extract_picture(&old_str) {
            if let Err(e) = crate::artwork::set_picture(&new_path.to_string_lossy(), data) {
                eprintln!("replace: artwork embed failed ({e})");
            }
        }
    }

    // 3. 長さ・技術メタデータ。
    let (duration_ms, tech_meta) = match read_duration_and_tech(&new_path) {
        Ok(v) => v,
        Err(e) => {
            cleanup(&new_path);
            return Err(format!("新しいファイルを読めませんでした: {e}"));
        }
    };

    // 4. 旧ファイルの退避。
    let mut moved_to: Option<PathBuf> = None;
    let old_file = match (&old_path, old_exists) {
        (Some(old), true) => {
            let old_str = old.to_string_lossy();
            let shared = db
                .other_tracks_reference_path(&old_str, track_id)
                .map_err(|e| {
                    cleanup(&new_path);
                    e.to_string()
                })?;
            if shared {
                OldFileDisposition::KeptShared
            } else {
                let date = chrono::Local::now().format("%Y%m%d").to_string();
                let dest = replaced_destination(old, library_root, &date);
                let dest = organizer::resolve_collision(&dest, old);
                if let Err(e) = move_file(old, &dest) {
                    cleanup(&new_path);
                    return Err(format!("旧ファイルを退避できませんでした: {e}"));
                }
                moved_to = Some(dest.clone());
                OldFileDisposition::Moved {
                    to: dest.to_string_lossy().to_string(),
                }
            }
        }
        _ => OldFileDisposition::Missing,
    };

    // 衝突回避で名前が変わっていたら、旧ファイルが退いて空いた本来の名前へ。
    if owned {
        if let Some(d) = desired.filter(|d| *d != new_path && !d.exists()) {
            if std::fs::rename(&new_path, &d).is_ok() {
                new_path = d;
            }
        }
    }

    // 5. DB を 1 トランザクションで更新。
    let new_str = new_path.to_string_lossy().to_string();
    if let Err(e) = db.apply_track_replacement(
        track_id,
        &new_str,
        &path_to_file_url(&new_str),
        duration_ms,
        &tech_meta,
    ) {
        // 旧ファイルを戻し、新ファイルを片付ける。
        if let (Some(dest), Some(old)) = (&moved_to, &old_path) {
            let _ = move_file(dest, old);
        }
        cleanup(&new_path);
        return Err(format!("ライブラリを更新できませんでした: {e}"));
    }

    Ok(ReplaceOutcome {
        new_path: new_str,
        old_file,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tempfile::TempDir;

    /// lofty が読める最小の PCM WAV (16bit / mono / 8kHz、`secs` 秒の無音)。
    pub(crate) fn write_wav(path: &Path, secs: u32) {
        let rate = 8000u32;
        let data_len = rate * 2 * secs;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&1u16.to_le_bytes()); // mono
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * 2).to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        v.extend(std::iter::repeat_n(0u8, data_len as usize));
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, v).unwrap();
    }

    struct Fixture {
        _tmp: TempDir,
        root: PathBuf,
        db: Database,
        track_id: i64,
        old: PathBuf,
        playlist_id: i64,
    }

    fn fixture() -> Fixture {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("Music");
        let old = root.join("Artist/Album/01 Song.wav");
        write_wav(&old, 3);
        let db = Database::open_memory().unwrap();
        let old_str = old.to_string_lossy().to_string();
        let track_id = db
            .add_imported_track(
                Some("Song"),
                Some("Artist"),
                Some("Artist"),
                Some("Album"),
                Some("Rock"),
                Some(2001),
                Some(1),
                Some(10),
                Some(1),
                Some(1),
                Some(0), // 壊れた長さ
                &old_str,
                &path_to_file_url(&old_str),
            )
            .unwrap();
        db.set_rating(track_id, 80).unwrap();
        db.mark_played(track_id).unwrap();
        db.conn
            .execute(
                "UPDATE tracks SET name = 'Song (my edit)', codec = 'OLD', bitrate_kbps = 1 WHERE track_id = ?1",
                [track_id],
            )
            .unwrap();
        let pid: String = db
            .conn
            .query_row(
                "SELECT persistent_id FROM tracks WHERE track_id = ?1",
                [track_id],
                |r| r.get(0),
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO track_analysis (persistent_id, track_id, version, bpm) VALUES (?1, ?2, 2, 120.0)",
                rusqlite::params![pid, track_id],
            )
            .unwrap();
        let playlist_id = db.create_playlist("P", None, false).unwrap().playlist_id;
        db.add_tracks_to_playlist(playlist_id, &[track_id]).unwrap();
        Fixture {
            _tmp: tmp,
            root,
            db,
            track_id,
            old,
            playlist_id,
        }
    }

    type Snapshot = (
        i64,
        String,
        Option<i64>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    fn snapshot(db: &Database, track_id: i64) -> Snapshot {
        db.conn
            .query_row(
                "SELECT track_id, persistent_id, rating, play_count, date_added, name, location_path
                 FROM tracks WHERE track_id = ?1",
                [track_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap()
    }

    fn analysis_rows(db: &Database) -> i64 {
        db.conn
            .query_row("SELECT COUNT(*) FROM track_analysis", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn replace_repoints_row_and_keeps_identity() {
        let f = fixture();
        let before = snapshot(&f.db, f.track_id);
        let new_src = f._tmp.path().join("rip/new.wav");
        write_wav(&new_src, 20);
        let desired = target_for_track(
            &f.root,
            &f.db.get_track_by_track_id(f.track_id).unwrap().unwrap(),
            &new_src,
        );
        let out = finalize_replacement(
            &f.db,
            f.track_id,
            NewFile {
                path: new_src.clone(),
                owned: true,
                desired: Some(desired.clone()),
                library_root: Some(&f.root),
            },
        )
        .unwrap();

        // 旧ファイルは消さずに _replaced/<date>/ へ (相対パスを保って) 退避。
        let OldFileDisposition::Moved { to } = &out.old_file else {
            panic!("expected moved: {:?}", out.old_file)
        };
        let to = PathBuf::from(to);
        assert!(to.is_file());
        assert!(!f.old.exists());
        assert!(to.starts_with(f.root.join("_replaced")));
        assert!(to.ends_with("Artist/Album/01 Song.wav"));

        let after = snapshot(&f.db, f.track_id);
        assert_eq!(after.0, before.0);
        assert_eq!(after.1, before.1); // persistent_id
        assert_eq!(after.2, Some(80)); // rating
        assert_eq!(after.3, before.3); // play_count
        assert_eq!(after.4, before.4); // date_added
        assert_eq!(after.5.as_deref(), Some("Song (my edit)"));
        assert_eq!(after.6.as_deref(), Some(out.new_path.as_str()));
        assert_eq!(
            f.db.get_playlist_track_ids(f.playlist_id).unwrap(),
            vec![f.track_id]
        );

        let t = f.db.get_track_by_track_id(f.track_id).unwrap().unwrap();
        assert!(t.file_exists);
        assert!((19_000..=21_000).contains(&t.total_time_ms.unwrap()));
        assert_ne!(t.codec.as_deref(), Some("OLD"));
        assert_ne!(t.bitrate_kbps, Some(1));
        assert_eq!(analysis_rows(&f.db), 0);

        // 新ファイルには既存行 (ユーザー編集) のタグが書かれている。
        let tagged = Probe::open(&out.new_path).unwrap().read().unwrap();
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag()).unwrap();
        use lofty::tag::Accessor;
        assert_eq!(tag.title().as_deref(), Some("Song (my edit)"));
    }

    #[test]
    fn collision_with_old_name_is_resolved_and_renamed_after_move() {
        let f = fixture();
        // 新ファイルが旧ファイルと同じ名前を望む (同じ拡張子での置き換え)。
        let desired = f.old.clone();
        let staged = organizer::resolve_collision(&desired, Path::new("/nonexistent"));
        assert_ne!(staged, desired);
        write_wav(&staged, 20);
        let out = finalize_replacement(
            &f.db,
            f.track_id,
            NewFile {
                path: staged.clone(),
                owned: true,
                desired: Some(desired.clone()),
                library_root: Some(&f.root),
            },
        )
        .unwrap();
        assert_eq!(PathBuf::from(&out.new_path), desired);
        assert!(desired.is_file());
        assert!(!staged.exists());
    }

    #[test]
    fn failure_leaves_row_and_old_file_untouched() {
        let f = fixture();
        let before = snapshot(&f.db, f.track_id);
        let bogus = f._tmp.path().join("rip/bogus.flac");
        std::fs::create_dir_all(bogus.parent().unwrap()).unwrap();
        std::fs::write(&bogus, b"not audio").unwrap();
        let err = finalize_replacement(
            &f.db,
            f.track_id,
            NewFile {
                path: bogus.clone(),
                owned: true,
                desired: None,
                library_root: Some(&f.root),
            },
        );
        assert!(err.is_err());
        assert_eq!(snapshot(&f.db, f.track_id), before);
        assert!(f.old.is_file());
        assert!(!bogus.exists(), "owned new file is cleaned up");
        assert_eq!(analysis_rows(&f.db), 1);
        let t = f.db.get_track_by_track_id(f.track_id).unwrap().unwrap();
        assert_eq!(t.codec.as_deref(), Some("OLD"));
    }

    #[test]
    fn same_file_is_rejected_and_not_deleted() {
        let f = fixture();
        let err = finalize_replacement(
            &f.db,
            f.track_id,
            NewFile {
                path: f.old.clone(),
                owned: true,
                desired: None,
                library_root: Some(&f.root),
            },
        );
        assert!(err.is_err());
        assert!(f.old.is_file());
    }

    #[test]
    fn shared_old_file_is_kept_and_missing_old_file_is_ok() {
        let f = fixture();
        let old_str = f.old.to_string_lossy().to_string();
        f.db.add_imported_track(
            Some("Dup"),
            Some("Artist"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            &old_str,
            &path_to_file_url(&old_str),
        )
        .unwrap();
        let new_src = f._tmp.path().join("in/new.wav");
        write_wav(&new_src, 20);
        let out = finalize_replacement(
            &f.db,
            f.track_id,
            NewFile {
                path: new_src.clone(),
                owned: false,
                desired: None,
                library_root: None,
            },
        )
        .unwrap();
        assert_eq!(out.old_file, OldFileDisposition::KeptShared);
        assert!(f.old.is_file());
        assert_eq!(PathBuf::from(&out.new_path), new_src);

        // 旧ファイルが無い曲の置き換え。
        let g = fixture();
        std::fs::remove_file(&g.old).unwrap();
        let src = g._tmp.path().join("in/x.wav");
        write_wav(&src, 20);
        let out = finalize_replacement(
            &g.db,
            g.track_id,
            NewFile {
                path: src,
                owned: false,
                desired: None,
                library_root: None,
            },
        )
        .unwrap();
        assert_eq!(out.old_file, OldFileDisposition::Missing);
    }

    #[test]
    fn replaced_destination_layout() {
        let root = Path::new("/lib");
        assert_eq!(
            replaced_destination(Path::new("/lib/A/B/1.mp3"), Some(root), "20261110"),
            PathBuf::from("/lib/_replaced/20261110/A/B/1.mp3")
        );
        assert_eq!(
            replaced_destination(Path::new("/else/1.mp3"), Some(root), "20261110"),
            PathBuf::from("/lib/_replaced/20261110/1.mp3")
        );
        assert_eq!(
            replaced_destination(Path::new("/else/1.mp3"), None, "20261110"),
            PathBuf::from("/else/_replaced/20261110/1.mp3")
        );
    }
}
