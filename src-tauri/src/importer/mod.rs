use std::collections::HashSet;
use std::path::{Path, PathBuf};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};

use crate::db::Database;
use crate::itunes_xml::writer::path_to_file_url;
use crate::metadata::tech;
use crate::models::{
    FileCheckSummary, ImportFileResult, ImportSummary, TechMetaRefreshSummary, Track,
};
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
    // 技術メタデータ (#171)。読み取り済みのプロパティから組み立て、再 probe はしない。
    // ファイルサイズは元ファイルのもの (整理 ON のコピー先も同一内容)。
    let file_size = std::fs::metadata(path).ok().map(|m| m.len());
    let tech = tech::from_properties(&tagged.file_type(), properties, file_size);

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
    if let Err(e) = db.set_track_tech_meta(track_id, &tech) {
        eprintln!("import: tech meta update failed for {} ({})", track_id, e);
    }

    Ok(track_id)
}

/// 1 曲分の技術メタデータ (#171) をファイルから読み直して DB に書く。
/// タグ由来の列 (曲名・アーティスト等) には触れない。
pub fn refresh_tech_meta_from_file(
    db: &Database,
    track_id: i64,
    path: &Path,
) -> Result<(), String> {
    let meta = tech::read_tech_meta(path)?;
    db.set_track_tech_meta(track_id, &meta)
        .map_err(|e| format!("db update failed: {e}"))?;
    Ok(())
}

/// 技術メタデータが未取得 (NULL) の曲だけを対象に、ファイルから一括で読み直す (#171)。
/// ファイルが無い / 読めない曲は `failed` に数え、処理は止めない。
/// `on_progress(done, total)` は `import_folders` と同じく最初に `0/total` を 1 回通知する。
pub fn refresh_missing_tech_meta(
    db: &Database,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<TechMetaRefreshSummary, String> {
    let targets = db
        .tracks_missing_tech_meta()
        .map_err(|e| format!("query failed: {e}"))?;
    let total = targets.len();
    let mut summary = TechMetaRefreshSummary {
        total,
        ..Default::default()
    };
    on_progress(0, total);
    for (i, (track_id, location_path)) in targets.iter().enumerate() {
        let path = Path::new(location_path);
        if !path.is_file() {
            summary.missing += 1;
        } else {
            match refresh_tech_meta_from_file(db, *track_id, path) {
                Ok(()) => summary.updated += 1,
                Err(e) => {
                    eprintln!("refresh_tech_meta: failed {} ({})", location_path, e);
                    summary.failed += 1;
                }
            }
        }
        on_progress(i + 1, total);
    }
    Ok(summary)
}

/// 全曲の `location_path` を stat し直し、`file_exists` を実態に合わせる (リンク切れ再チェック)。
/// 欠損 → 発見 / 発見 → 欠損の両方向を反映する。場所が空の曲は欠損扱い (XML 取り込みと同じ)。
/// ファイル確認は DB を握らずに全件済ませ、変化があった行だけを最後に 1 トランザクションで書く。
/// `on_progress(done, total)` は他の一括処理と同じく最初に `0/total` を 1 回通知する。
pub fn rescan_file_existence(
    db: &Database,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<FileCheckSummary, String> {
    let rows = db
        .track_locations_for_file_check()
        .map_err(|e| format!("query failed: {e}"))?;
    let total = rows.len();
    let mut summary = FileCheckSummary {
        checked: total,
        ..Default::default()
    };
    let mut updates: Vec<(i64, Option<String>, bool)> = Vec::new();
    on_progress(0, total);
    for (i, (track_id, location_path, prev)) in rows.iter().enumerate() {
        let exists = location_path
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            .is_some_and(|p| Path::new(p).is_file());
        if !exists {
            summary.missing += 1;
        }
        match (*prev, exists) {
            (Some(true), false) => summary.newly_missing += 1,
            (Some(false), true) => summary.newly_found += 1,
            _ => {}
        }
        if *prev != Some(exists) {
            updates.push((*track_id, location_path.clone(), exists));
        }
        on_progress(i + 1, total);
    }
    db.set_file_exists_bulk(&updates)
        .map_err(|e| format!("db update failed: {e}"))?;
    Ok(summary)
}

/// リンク切れ (または場所を変えたい) 曲の実ファイルを手動で付け替える。
/// 指定パスが実在するファイルであることを確かめてから `location_path` / `location_raw`
/// (`file://` URL) を書き換え、`file_exists = 1` にして更新後の Track を返す。
/// 付け替え先は別のエンコードの場合もあるので、技術メタデータ (#171) はベストエフォートで
/// 読み直す (失敗しても付け替え自体は成功扱い)。ジャケットはパス基準の URL で引くので
/// キャッシュの無効化は不要。
pub fn relocate_track(db: &Database, track_id: i64, new_path: &str) -> Result<Track, String> {
    let path = Path::new(new_path);
    if new_path.trim().is_empty() || !path.is_absolute() {
        return Err(format!("絶対パスを指定してください: {}", new_path));
    }
    if !path.exists() {
        return Err(format!("ファイルが見つかりません: {}", new_path));
    }
    if !path.is_file() {
        return Err(format!("ファイルではありません: {}", new_path));
    }
    if db
        .get_track_by_track_id(track_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("トラックが見つかりません (id={})", track_id));
    }
    db.relink_track_location(track_id, new_path, &path_to_file_url(new_path))
        .map_err(|e| format!("db update failed: {e}"))?;
    if let Err(e) = refresh_tech_meta_from_file(db, track_id, path) {
        eprintln!(
            "relocate: tech meta refresh failed for {} ({})",
            new_path, e
        );
    }
    db.get_track_by_track_id(track_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("トラックが見つかりません (id={})", track_id))
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

    /// #171: NULL の技術列だけを持つ曲をファイルから埋め、タグ由来列は変えない。
    /// ファイルが無い曲は missing に数え、読めないファイルは failed に数える。
    #[test]
    fn refresh_missing_tech_meta_fills_only_technical_columns() {
        let tmp = TempDir::new().unwrap();
        let wav = tmp.path().join("a.wav");
        crate::metadata::tech::write_test_wav(&wav);
        let junk = tmp.path().join("b.mp3");
        fs::write(&junk, b"not audio").unwrap();
        let gone = tmp.path().join("gone.flac");

        let db = Database::open_memory().unwrap();
        let mut ids = Vec::new();
        for (name, p) in [("Edited", &wav), ("Junk", &junk), ("Gone", &gone)] {
            let path = p.to_string_lossy().to_string();
            ids.push(
                db.add_imported_track(
                    Some(name),
                    Some("Artist"),
                    None,
                    None,
                    Some("House"),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    &path,
                    &path_to_file_url(&path),
                )
                .unwrap(),
            );
        }

        let mut last = (0, 0);
        let summary = refresh_missing_tech_meta(&db, |d, t| last = (d, t)).unwrap();
        assert_eq!(summary.total, 3);
        assert_eq!(summary.updated, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.missing, 1);
        assert_eq!(last, (3, 3));

        let t = db.get_track_by_track_id(ids[0]).unwrap().unwrap();
        assert_eq!(t.codec.as_deref(), Some("WAV"));
        assert_eq!(t.sample_rate_hz, Some(44_100));
        assert_eq!(t.bit_depth, Some(16));
        assert_eq!(t.channels, Some(2));
        assert!(t.file_size_bytes.unwrap() > 0);
        // ユーザー編集の対象列はそのまま。
        assert_eq!(t.name.as_deref(), Some("Edited"));
        assert_eq!(t.genre.as_deref(), Some("House"));

        // 埋まった曲は次回の対象外。
        let remaining: Vec<i64> = db
            .tracks_missing_tech_meta()
            .unwrap()
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(remaining, vec![ids[1], ids[2]]);
    }

    /// テスト用: 指定パスを location に持つ曲を 1 件追加して track_id を返す。
    fn add_track_at(db: &Database, name: &str, path: &Path) -> i64 {
        let path = path.to_string_lossy().to_string();
        db.add_imported_track(
            Some(name),
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
            &path,
            &path_to_file_url(&path),
        )
        .unwrap()
    }

    fn file_exists_of(db: &Database, track_id: i64) -> bool {
        db.get_track_by_track_id(track_id)
            .unwrap()
            .unwrap()
            .file_exists
    }

    /// リンク切れ再チェック: 消えたファイルは欠損に、戻ってきたファイルは発見に、
    /// 両方向で file_exists を更新し、件数を正しく数える。
    #[test]
    fn rescan_file_existence_updates_both_directions() {
        let tmp = TempDir::new().unwrap();
        let keep = tmp.path().join("keep.mp3");
        let removed = tmp.path().join("removed.mp3");
        let restored = tmp.path().join("restored.flac");
        touch(&keep);
        touch(&removed);
        touch(&restored);

        let db = Database::open_memory().unwrap();
        let keep_id = add_track_at(&db, "Keep", &keep);
        let removed_id = add_track_at(&db, "Removed", &removed);
        let restored_id = add_track_at(&db, "Restored", &restored);
        // 場所が空の曲は常に欠損扱い。
        let no_loc_id = add_track_at(&db, "NoLocation", Path::new(""));
        // ディレクトリはファイルとして扱わない。
        let dir_id = add_track_at(&db, "Dir", tmp.path());

        // 1 回目: 全曲 file_exists=1 で入っているので、空パスとディレクトリだけが新たに欠損。
        let s = rescan_file_existence(&db, |_, _| {}).unwrap();
        assert_eq!(s.checked, 5);
        assert_eq!(s.missing, 2);
        assert_eq!(s.newly_missing, 2);
        assert_eq!(s.newly_found, 0);
        assert!(!file_exists_of(&db, no_loc_id));
        assert!(!file_exists_of(&db, dir_id));

        // ファイルを消す / 欠損扱いの曲のファイルが戻る状況を作る。
        fs::remove_file(&removed).unwrap();
        fs::remove_file(&restored).unwrap();
        let s = rescan_file_existence(&db, |_, _| {}).unwrap();
        assert_eq!(s.missing, 4);
        assert_eq!(s.newly_missing, 2);
        assert_eq!(s.newly_found, 0);
        assert!(!file_exists_of(&db, removed_id));
        assert!(!file_exists_of(&db, restored_id));

        touch(&restored);
        let mut last = (0, 0);
        let mut calls = 0;
        let s = rescan_file_existence(&db, |d, t| {
            last = (d, t);
            calls += 1;
        })
        .unwrap();
        assert_eq!(s.checked, 5);
        assert_eq!(s.missing, 3);
        assert_eq!(s.newly_missing, 0);
        assert_eq!(s.newly_found, 1);
        assert!(file_exists_of(&db, keep_id));
        assert!(file_exists_of(&db, restored_id));
        assert!(!file_exists_of(&db, removed_id));
        // 0/total を最初に 1 回 + 1 曲ごと。
        assert_eq!(last, (5, 5));
        assert_eq!(calls, 6);

        // 変化が無ければ newly_* は 0 のまま。
        let s = rescan_file_existence(&db, |_, _| {}).unwrap();
        assert_eq!((s.missing, s.newly_missing, s.newly_found), (3, 0, 0));
    }

    #[test]
    fn rescan_file_existence_on_empty_library() {
        let db = Database::open_memory().unwrap();
        let mut last = None;
        let s = rescan_file_existence(&db, |d, t| last = Some((d, t))).unwrap();
        assert_eq!(
            (s.checked, s.missing, s.newly_missing, s.newly_found),
            (0, 0, 0, 0)
        );
        assert_eq!(last, Some((0, 0)));
    }

    /// 確認中に場所が変わった行は、古いパスでの判定で file_exists を上書きしない。
    #[test]
    fn file_exists_bulk_skips_rows_whose_location_changed() {
        let tmp = TempDir::new().unwrap();
        let old = tmp.path().join("old.mp3");
        let new = tmp.path().join("new.mp3");
        touch(&old);
        touch(&new);
        let db = Database::open_memory().unwrap();
        let id = add_track_at(&db, "Moved", &old);
        let old_str = old.to_string_lossy().to_string();
        // 確認後・書き込み前に別の場所へ付け替えられた想定。
        relocate_track(&db, id, &new.to_string_lossy()).unwrap();
        let n = db.set_file_exists_bulk(&[(id, Some(old_str), false)]).unwrap();
        assert_eq!(n, 0);
        assert!(file_exists_of(&db, id));
    }

    /// 手動付け替え: 実在しないパス / ディレクトリ / 相対パスは拒否し、DB は変えない。
    #[test]
    fn relocate_track_rejects_invalid_paths() {
        let tmp = TempDir::new().unwrap();
        let gone = tmp.path().join("gone.mp3");
        let db = Database::open_memory().unwrap();
        let id = add_track_at(&db, "Gone", &gone);
        rescan_file_existence(&db, |_, _| {}).unwrap();
        assert!(!file_exists_of(&db, id));

        let nowhere = tmp.path().join("nowhere.mp3");
        assert!(relocate_track(&db, id, &nowhere.to_string_lossy()).is_err());
        assert!(relocate_track(&db, id, &tmp.path().to_string_lossy()).is_err());
        assert!(relocate_track(&db, id, "relative/song.mp3").is_err());
        assert!(relocate_track(&db, id, "").is_err());

        let t = db.get_track_by_track_id(id).unwrap().unwrap();
        assert_eq!(
            t.location_path.as_deref(),
            Some(gone.to_string_lossy().as_ref())
        );
        assert!(!t.file_exists);

        // 存在しない track_id もエラー。
        let real = tmp.path().join("real.mp3");
        touch(&real);
        assert!(relocate_track(&db, 9999, &real.to_string_lossy()).is_err());
    }

    /// 手動付け替え: location_path / location_raw (file:// URL) / file_exists を更新し、
    /// 付け替え先から技術メタデータも読み直す。
    #[test]
    fn relocate_track_updates_location_and_file_exists() {
        let tmp = TempDir::new().unwrap();
        let gone = tmp.path().join("old/gone.wav");
        let db = Database::open_memory().unwrap();
        let id = add_track_at(&db, "Song", &gone);
        rescan_file_existence(&db, |_, _| {}).unwrap();
        assert!(!file_exists_of(&db, id));

        let new = tmp.path().join("new place/song.wav");
        fs::create_dir_all(new.parent().unwrap()).unwrap();
        crate::metadata::tech::write_test_wav(&new);
        let new_str = new.to_string_lossy().to_string();

        let t = relocate_track(&db, id, &new_str).unwrap();
        assert_eq!(t.track_id, id);
        assert_eq!(t.location_path.as_deref(), Some(new_str.as_str()));
        assert_eq!(
            t.location_raw.as_deref(),
            Some(path_to_file_url(&new_str).as_str())
        );
        assert!(t.file_exists);
        assert_eq!(t.codec.as_deref(), Some("WAV"));
        // タグ由来の列には触れない。
        assert_eq!(t.name.as_deref(), Some("Song"));

        // 再チェックしても見つかったままで、newly_found には数えない (既に 1)。
        let s = rescan_file_existence(&db, |_, _| {}).unwrap();
        assert_eq!((s.missing, s.newly_missing, s.newly_found), (0, 0, 0));
    }
}
