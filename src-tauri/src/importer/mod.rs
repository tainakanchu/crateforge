use std::path::{Path, PathBuf};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};

use crate::db::Database;
use crate::itunes_xml::writer::path_to_file_url;
use crate::models::ImportFileResult;
use crate::organizer;

/// 任意の音声ファイル群をライブラリ DB に追加する。
/// 既存パスとの重複検査は行わない (UI 側で確認することを想定)。
///
/// `library_root` が設定済み (整理 ON) の場合は、ファイルを
/// `<root>/<AlbumArtist>/<Album>/` 配下へ **コピー** してから登録する
/// (元ファイルは残す)。未設定なら従来どおりその場参照で登録する。
pub fn import_files(db: &Database, paths: &[String]) -> ImportFileResult {
    let mut added = 0usize;
    let mut skipped = 0usize;

    let root = db.organize_root().map(PathBuf::from);

    for raw_path in paths {
        let path = Path::new(raw_path);
        if !path.exists() {
            skipped += 1;
            continue;
        }

        match read_and_insert(db, path, root.as_deref()) {
            Ok(_) => added += 1,
            Err(e) => {
                eprintln!("import_files: skipped {} ({})", raw_path, e);
                skipped += 1;
            }
        }
    }

    ImportFileResult {
        added_tracks: added,
        skipped,
    }
}

/// 既存ファイル (変換結果など) を整理せず、その場参照でライブラリへ追加する。
/// 追加した track_id を返す。
pub fn import_in_place(db: &Database, path: &Path) -> Result<i64, String> {
    read_and_insert(db, path, None)
}

fn read_and_insert(db: &Database, path: &Path, library_root: Option<&Path>) -> Result<i64, String> {
    let tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {}", e))?
        .read()
        .map_err(|e| format!("probe failed: {}", e))?;

    let properties = tagged.properties();
    let total_time_ms = Some(properties.duration().as_millis() as i64);

    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let (title, artist, album_artist, album, genre, year, track_number, track_count): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
    ) = match tag {
        Some(t) => (
            t.title().map(|s| s.to_string()),
            t.artist().map(|s| s.to_string()),
            // lofty doesn't expose album_artist uniformly; we let it default to None
            // and fall back to artist in the DB call below.
            None,
            t.album().map(|s| s.to_string()),
            t.genre().map(|s| s.to_string()),
            t.year().map(|y| y as i64),
            t.track().map(|n| n as i64),
            t.track_total().map(|n| n as i64),
        ),
        None => (None, None, None, None, None, None, None, None),
    };

    // Disc 情報 (ファイル名のディスクプレフィックス判定と DB 保存に使う)。
    let disc_number = tag.and_then(|t| t.disk()).map(|n| n as i64);
    let disc_count = tag.and_then(|t| t.disk_total()).map(|n| n as i64);

    // BPM タグ (TBPM/tmpo/Vorbis BPM)。挿入後に set_track_bpm で埋める。
    let bpm = tag.and_then(read_bpm);

    // Fall back to filename if no title tag.
    let fallback_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(String::from);
    let title = title.or(fallback_title);

    // Fall back: parent dir = album, grandparent = artist (Music/Artist/Album/Track.mp3).
    let parent = path.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str());
    let grandparent = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str());
    let album = album.or_else(|| parent.map(String::from));
    let artist = artist.or_else(|| grandparent.map(String::from));

    // 整理 ON ならルート配下へコピー (iTunes 準拠のリネーム込み)。
    // 失敗したら元パスのまま続行 (警告のみ)。
    // ばらのファイル取り込みでは Compilation フラグはまず付かないため false 固定。
    let mut location_path = path.to_string_lossy().to_string();
    if let Some(root) = library_root {
        let meta = organizer::TrackMeta {
            title: title.as_deref(),
            artist: artist.as_deref(),
            album_artist: album_artist.as_deref().or(artist.as_deref()),
            album: album.as_deref(),
            compilation: false,
            track_number,
            disc_number,
            disc_count,
        };
        let target = organizer::target_path(root, &meta, path);
        match organizer::relocate(path, &target, organizer::Mode::Copy) {
            Ok(dest) => location_path = dest.to_string_lossy().to_string(),
            Err(e) => eprintln!("organize on import failed: {}", e),
        }
    }
    let location_url = path_to_file_url(&location_path);

    let track_id = db
        .add_imported_track(
            title.as_deref(),
            artist.as_deref(),
            album_artist.as_deref().or(artist.as_deref()),
            album.as_deref(),
            genre.as_deref(),
            year,
            track_number,
            track_count,
            disc_number,
            disc_count,
            total_time_ms,
            &location_path,
            &location_url,
        )
        .map_err(|e| format!("db insert failed: {}", e))?;

    if let Some(b) = bpm {
        let _ = db.set_track_bpm(track_id, b);
    }

    Ok(track_id)
}

/// タグから BPM を読む。TBPM/tmpo (IntegerBpm) を優先し、無ければ Vorbis "BPM"。
/// "128" / "128.00" の両方を許容し、四捨五入して正の整数のみ採用する。
fn read_bpm(tag: &Tag) -> Option<i64> {
    tag.get_string(&ItemKey::IntegerBpm)
        .or_else(|| tag.get_string(&ItemKey::Bpm))
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|f| f.round() as i64)
        .filter(|&n| n > 0)
}
