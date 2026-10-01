use std::collections::HashSet;
use std::path::{Path, PathBuf};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};

use crate::db::Database;
use crate::itunes_xml::writer::path_to_file_url;
use crate::models::{ImportFileResult, ImportSummary};
use crate::organizer;

/// 取り込み対象とするオーディオ拡張子 (小文字)。
/// フロントの `src/lib/audioExtensions.ts` の `AUDIO_EXTENSIONS` と揃えること
/// (ファイル選択ダイアログ / D&D のフィルタと同じ集合にする)。
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "mp3", "m4a", "wav", "aac", "ogg", "opus", "aiff", "wma",
];

/// フォルダ探索の最大深さ。異常なネスト (壊れたリンク構造など) で暴走しない保険。
const MAX_DEPTH: usize = 32;

/// 拡張子が対応オーディオ形式かどうか (大文字小文字は無視)。
pub fn is_audio_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let lower = ext.to_ascii_lowercase();
            AUDIO_EXTENSIONS.contains(&lower.as_str())
        }
        None => false,
    }
}

/// 隠しファイル/隠しフォルダ (`.` 始まり) かどうか。macOS の `.DS_Store` や
/// `.git` などを取り込まないために使う。
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

/// `roots` に含まれるファイル / フォルダを再帰的に走査し、対応オーディオファイルの
/// パスをソート済み・重複なしで返す。
///
/// - フォルダは深さ優先で再帰的に辿る (`std::fs::read_dir`)。
/// - 隠しファイル / 隠しフォルダ (`.` 始まり) はスキップする。ただし利用者が
///   明示的に指定した root 自身は隠しでも対象にする。
/// - シンボリックリンクのループは訪問済みディレクトリ (canonicalize 済み) の
///   集合と深さ上限で防ぐ。
/// - 読めないディレクトリは黙って読み飛ばす (権限エラーなどで全体を止めない)。
pub fn collect_audio_files(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    // 同じ実体のディレクトリを二度辿らない = シンボリックリンクのループ対策。
    let mut visited: HashSet<PathBuf> = HashSet::new();
    // (パス, 深さ) のスタックで深さ優先探索する (再帰でスタックを溢れさせない)。
    let mut stack: Vec<(PathBuf, usize)> = Vec::new();

    for root in roots {
        if root.is_dir() {
            stack.push((root.clone(), 0));
        } else if root.is_file() && is_audio_file(root) {
            // 明示指定されたファイルは隠しでも受け入れる。
            out.push(root.clone());
        }
    }

    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            continue;
        }
        // canonicalize できない場合はパスそのものを鍵にして少なくとも同一パスの
        // 再訪だけは防ぐ。
        let key = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(key) {
            continue;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("collect_audio_files: skip {} ({})", dir.display(), e);
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if is_hidden(&path) {
                continue;
            }
            // `file_type()` はリンク自身を指すので、リンク先の種別は `path.is_dir()`
            // (= metadata 追従) で判定する。ループは visited 側で止める。
            if path.is_dir() {
                stack.push((path, depth + 1));
            } else if path.is_file() && is_audio_file(&path) {
                out.push(path);
            }
        }
    }

    out.sort();
    out.dedup();
    out
}

/// フォルダ (およびファイル) をまとめて取り込む。
/// フォルダは再帰的に展開し、既にライブラリに登録済みのパスは `skipped` に数える。
/// 読み取り/DB 追加に失敗したファイルは `failed` に数える。
///
/// `on_progress(done, total)` を 1 ファイルごとに呼ぶ (`total` は展開後のファイル数。
/// 走査完了時点で確定するので、最初に `0/total` を 1 回通知する)。進捗が不要なら
/// `|_, _| {}` を渡す。
pub fn import_folders(
    db: &Database,
    roots: &[PathBuf],
    mut on_progress: impl FnMut(usize, usize),
) -> ImportSummary {
    let files = collect_audio_files(roots);
    let existing = db.existing_location_paths().unwrap_or_default();
    let root_dir = db.organize_root().map(PathBuf::from);

    let mut summary = ImportSummary::default();
    let total = files.len();
    on_progress(0, total);

    for (i, file) in files.iter().enumerate() {
        let as_str = file.to_string_lossy().to_string();
        if existing.contains(&as_str) {
            summary.skipped += 1;
        } else {
            match read_and_insert(db, file, root_dir.as_deref()) {
                Ok(_) => summary.imported += 1,
                Err(e) => {
                    eprintln!("import_folders: failed {} ({})", as_str, e);
                    summary.failed += 1;
                }
            }
        }
        on_progress(i + 1, total);
    }

    summary
}

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
    let fallback_title = path.file_stem().and_then(|s| s.to_str()).map(String::from);
    let title = title.or(fallback_title);

    // Fall back: parent dir = album, grandparent = artist (Music/Artist/Album/Track.mp3).
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"x").unwrap();
    }

    /// 収集結果をルートからの相対パス文字列 (`/` 区切り) にして比較しやすくする。
    fn rel(root: &Path, files: &[PathBuf]) -> Vec<String> {
        files
            .iter()
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn collects_audio_files_recursively_sorted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        touch(&root.join("b.mp3"));
        touch(&root.join("a.flac"));
        touch(&root.join("Artist/Album/01.m4a"));
        touch(&root.join("Artist/Album/02.WAV")); // 大文字拡張子も拾う
        touch(&root.join("Artist/notes.txt")); // 非オーディオは除外
        touch(&root.join("cover.jpg"));

        let files = collect_audio_files(&[root.to_path_buf()]);
        assert_eq!(
            rel(root, &files),
            vec![
                "Artist/Album/01.m4a",
                "Artist/Album/02.WAV",
                "a.flac",
                "b.mp3",
            ]
        );
    }

    #[test]
    fn skips_hidden_files_and_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        touch(&root.join("ok.mp3"));
        touch(&root.join(".hidden.mp3"));
        touch(&root.join(".hidden_dir/inside.mp3"));
        touch(&root.join("sub/.DS_Store"));
        touch(&root.join("sub/ok2.flac"));

        let files = collect_audio_files(&[root.to_path_buf()]);
        assert_eq!(rel(root, &files), vec!["ok.mp3", "sub/ok2.flac"]);
    }

    #[test]
    fn accepts_plain_files_and_dedupes_overlapping_roots() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        touch(&root.join("sub/one.mp3"));
        touch(&root.join("two.ogg"));

        // フォルダとその中のファイルを同時に渡しても重複しない。
        let files = collect_audio_files(&[
            root.to_path_buf(),
            root.join("sub"),
            root.join("sub/one.mp3"),
            root.join("missing.mp3"),
        ]);
        assert_eq!(rel(root, &files), vec!["sub/one.mp3", "two.ogg"]);
    }

    #[test]
    fn non_audio_root_file_is_ignored() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        touch(&root.join("readme.txt"));
        assert!(collect_audio_files(&[root.join("readme.txt")]).is_empty());
        assert!(collect_audio_files(&[]).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_loop_terminates() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        touch(&root.join("deep/song.mp3"));
        // deep/loop -> root（自分自身を含む親へのリンク）で無限ループを作る。
        std::os::unix::fs::symlink(root, root.join("deep/loop")).unwrap();

        let files = collect_audio_files(&[root.to_path_buf()]);
        assert_eq!(rel(root, &files), vec!["deep/song.mp3"]);
    }

    #[test]
    fn is_audio_file_checks_extension_case_insensitively() {
        assert!(is_audio_file(Path::new("/m/a.FLAC")));
        assert!(is_audio_file(Path::new("/m/a.mp3")));
        assert!(!is_audio_file(Path::new("/m/a.txt")));
        assert!(!is_audio_file(Path::new("/m/noext")));
    }
}
