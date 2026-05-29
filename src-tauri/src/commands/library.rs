use tauri::{AppHandle, Manager};

use crate::db::Database;
use crate::importer;
use crate::itunes_xml::{parser, writer};
use crate::models::{
    ExportResult, GenreTagCount, ImportFileResult, ImportResult, LibraryStats, Track, TrackEdit,
};

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

#[tauri::command]
pub fn get_library_stats(app: AppHandle) -> Result<LibraryStats, String> {
    let db = get_db(&app)?;
    db.library_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_track(app: AppHandle, track_id: i64, edits: TrackEdit) -> Result<(), String> {
    let db = get_db(&app)?;
    db.update_track(track_id, &edits).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_track_rating(app: AppHandle, track_id: i64, rating: i64) -> Result<(), String> {
    let db = get_db(&app)?;
    db.set_rating(track_id, rating).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_genre_tag(
    app: AppHandle,
    track_ids: Vec<i64>,
    tag: String,
) -> Result<(), String> {
    let db = get_db(&app)?;
    for tid in track_ids {
        db.add_genre_tag(tid, &tag).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_genre_tag(
    app: AppHandle,
    track_ids: Vec<i64>,
    tag: String,
) -> Result<(), String> {
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
