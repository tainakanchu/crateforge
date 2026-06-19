use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::db::Database;
use crate::importer;
use crate::itunes_xml::{parser, writer};
use crate::models::{
    ExportResult, GenreTagCount, ImportFileResult, ImportResult, LibraryStats, Track, TrackEdit,
};
use crate::organizer;

fn get_db(app: &AppHandle) -> Result<Database, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Database::open(&app_dir).map_err(|e| format!("Failed to open database: {}", e))
}

#[tauri::command]
pub fn import_library(app: AppHandle, xml_path: String) -> Result<ImportResult, String> {
    let db = get_db(&app)?;
    let (track_count, playlist_count, missing_files) = parser::import_library(&xml_path, &db)?;

    db.set_state("last_xml_path", &xml_path)
        .map_err(|e| e.to_string())?;

    Ok(ImportResult {
        track_count,
        playlist_count,
        missing_files,
    })
}

#[tauri::command]
pub fn export_library(app: AppHandle, output_path: String) -> Result<ExportResult, String> {
    let db = get_db(&app)?;
    writer::export_library(&db, &output_path)
}

#[tauri::command]
pub fn import_files(app: AppHandle, paths: Vec<String>) -> Result<ImportFileResult, String> {
    let db = get_db(&app)?;
    Ok(importer::import_files(&db, &paths))
}

#[tauri::command]
pub fn get_tracks(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = get_db(&app)?;
    db.get_tracks(
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        sort_field.as_deref(),
        sort_order.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_tracks(
    app: AppHandle,
    query: String,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = get_db(&app)?;
    db.search_tracks(
        &query,
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        sort_field.as_deref(),
        sort_order.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// track_id 列を入力順のまま Track へ解決する。見つからない ID はスキップ。
/// Up Next がフロントのロード済みページ (500件) を超える曲も表示できるようにするためのもの。
#[tauri::command]
pub fn get_tracks_by_ids(app: AppHandle, track_ids: Vec<i64>) -> Result<Vec<Track>, String> {
    let db = get_db(&app)?;
    db.get_tracks_by_ids(&track_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_library_stats(app: AppHandle) -> Result<LibraryStats, String> {
    let db = get_db(&app)?;
    db.library_stats().map_err(|e| e.to_string())
}

/// `Option<Option<i64>>` のパッチを最終値へ解決する。
/// `Some(Some(v))`=設定 / `Some(None)`=クリア / `None`=旧値を維持。
fn resolve_int(edit: &Option<Option<i64>>, before: Option<i64>) -> Option<i64> {
    match edit {
        Some(v) => *v,
        None => before,
    }
}

#[tauri::command]
pub fn update_track(app: AppHandle, track_id: i64, edits: TrackEdit) -> Result<(), String> {
    let db = get_db(&app)?;

    // 1. 編集前のトラックを取得 (旧 location / 非編集フィールドの保持に使う)。
    let before = db
        .get_track_by_track_id(track_id)
        .map_err(|e| e.to_string())?;

    // 2. DB を更新 (ここまでは必ず確定させる)。
    db.update_track(track_id, &edits)
        .map_err(|e| e.to_string())?;

    // 3. 整理のガード: ルート未設定 / 整理 OFF / 旧トラックやファイルが無いなら終了。
    //    タグ書き戻し・移動の失敗は「整理失敗」の警告に留め、編集自体は成功扱いとする。
    let Some(root) = db.organize_root() else {
        return Ok(());
    };
    let Some(before) = before else { return Ok(()) };
    let Some(loc) = before.location_path.clone() else {
        return Ok(());
    };
    let src = Path::new(&loc);
    if !src.exists() {
        return Ok(());
    }

    // 4. 最終値を確定 (edits 優先、来なかった項目は旧値)。
    let name = edits.name.clone().or(before.name.clone());
    let artist = edits.artist.clone().or(before.artist.clone());
    let album_artist = edits.album_artist.clone().or(before.album_artist.clone());
    let album = edits.album.clone().or(before.album.clone());
    let genre = edits.genre.clone().or(before.genre.clone());
    let year = resolve_int(&edits.year, before.year);
    let track_number = resolve_int(&edits.track_number, before.track_number);
    let track_count = resolve_int(&edits.track_count, before.track_count);
    let disc_number = resolve_int(&edits.disc_number, before.disc_number);
    let disc_count = resolve_int(&edits.disc_count, before.disc_count);
    // Compilation は編集された場合は新値、なければ旧値を引き継ぐ。
    let compilation = edits.compilation.unwrap_or(before.compilation);

    // 5. 実ファイルのタグを書き戻す (他アプリでも編集内容が見えるように)。
    let w = organizer::TagWrite {
        title: name.as_deref(),
        artist: artist.as_deref(),
        album_artist: album_artist.as_deref(),
        album: album.as_deref(),
        genre: genre.as_deref(),
        year,
        track_number,
        track_count,
        disc_number,
        disc_count,
        compilation: Some(compilation),
    };
    if let Err(e) = organizer::write_tags(src, &w) {
        eprintln!("write_tags failed for {}: {}", loc, e);
    }

    // 6-9. 新ターゲット (フォルダ分け + iTunes 準拠リネーム) を算出して移動し、
    //      DB の location を追従させる。
    let meta = organizer::TrackMeta {
        title: name.as_deref(),
        artist: artist.as_deref(),
        album_artist: album_artist.as_deref(),
        album: album.as_deref(),
        compilation,
        track_number,
        disc_number,
        disc_count,
    };
    let target = organizer::target_path(Path::new(&root), &meta, src);
    match organizer::relocate(src, &target, organizer::Mode::Move) {
        Ok(dest) if dest != src => {
            let dest_str = dest.to_string_lossy().to_string();
            let url = writer::path_to_file_url(&dest_str);
            db.set_track_location(track_id, &dest_str, &url)
                .map_err(|e| e.to_string())?;
        }
        Ok(_) => {}
        Err(e) => eprintln!("relocate failed for {}: {}", loc, e),
    }
    Ok(())
}

/// 整理先 (ライブラリルート) を取得する。未設定なら `None`。
#[tauri::command]
pub fn get_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let db = get_db(&app)?;
    db.get_state("library_root").map_err(|e| e.to_string())
}

/// 整理先 (ライブラリルート) を設定する。空文字を渡すと整理を無効化する。
#[tauri::command]
pub fn set_library_root(app: AppHandle, path: String) -> Result<(), String> {
    let db = get_db(&app)?;
    db.set_state("library_root", &path)
        .map_err(|e| e.to_string())
}

/// 既存トラックのパスから整理先(ライブラリルート)を自動推定する。推定不可なら None。
/// 設定 UI の「自動検出」から呼ぶ(検出のみ。確定は呼び出し側で set_library_root)。
#[tauri::command]
pub fn detect_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let db = get_db(&app)?;
    db.detect_library_root().map_err(|e| e.to_string())
}

/// 検索・スマプレの字体ゆれ吸収レベルを取得する。未設定なら "standard"。
#[tauri::command]
pub fn get_search_fold_level(app: AppHandle) -> Result<String, String> {
    let db = get_db(&app)?;
    Ok(db
        .get_state("search_fold_level")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "standard".to_string()))
}

/// 検索・スマプレの字体ゆれ吸収レベルを設定する。受理値は off/light/standard。
/// 不正値は standard に正規化する。
#[tauri::command]
pub fn set_search_fold_level(app: AppHandle, level: String) -> Result<(), String> {
    let v = match level.as_str() {
        "off" => "off",
        "light" => "light",
        _ => "standard",
    };
    let db = get_db(&app)?;
    db.set_state("search_fold_level", v)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_track_rating(app: AppHandle, track_id: i64, rating: i64) -> Result<(), String> {
    let db = get_db(&app)?;
    db.set_rating(track_id, rating).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_genre_tag(app: AppHandle, track_ids: Vec<i64>, tag: String) -> Result<(), String> {
    let db = get_db(&app)?;
    for tid in track_ids {
        db.add_genre_tag(tid, &tag).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_genre_tag(app: AppHandle, track_ids: Vec<i64>, tag: String) -> Result<(), String> {
    let db = get_db(&app)?;
    for tid in track_ids {
        db.remove_genre_tag(tid, &tag).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_all_genre_tags(app: AppHandle) -> Result<Vec<GenreTagCount>, String> {
    let db = get_db(&app)?;
    db.get_all_genre_tags().map_err(|e| e.to_string())
}

pub(crate) fn open_db(app: &AppHandle) -> Result<Database, String> {
    get_db(app)
}
