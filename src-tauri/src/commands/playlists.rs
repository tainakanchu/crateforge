use tauri::AppHandle;

use crate::commands::library::open_db;
use crate::models::{Playlist, Track};

#[tauri::command]
pub fn get_playlists(app: AppHandle) -> Result<Vec<Playlist>, String> {
    let db = open_db(&app)?;
    db.get_playlists().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_playlist_tracks(
    app: AppHandle,
    playlist_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = open_db(&app)?;
    db.get_playlist_tracks(
        playlist_id,
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        sort_field.as_deref(),
        sort_order.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_playlist(
    app: AppHandle,
    name: String,
    parent_persistent_id: Option<String>,
    is_folder: Option<bool>,
) -> Result<Playlist, String> {
    let db = open_db(&app)?;
    db.create_playlist(
        &name,
        parent_persistent_id.as_deref(),
        is_folder.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_playlist(app: AppHandle, playlist_id: i64, name: String) -> Result<(), String> {
    let db = open_db(&app)?;
    db.rename_playlist(playlist_id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_playlist(app: AppHandle, playlist_id: i64) -> Result<(), String> {
    let db = open_db(&app)?;
    db.delete_playlist(playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_tracks_to_playlist(
    app: AppHandle,
    playlist_id: i64,
    track_ids: Vec<i64>,
) -> Result<usize, String> {
    let db = open_db(&app)?;
    db.add_tracks_to_playlist(playlist_id, &track_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_track_from_playlist(
    app: AppHandle,
    playlist_id: i64,
    track_id: i64,
) -> Result<(), String> {
    let db = open_db(&app)?;
    db.remove_track_from_playlist(playlist_id, track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_playlist_tracks(
    app: AppHandle,
    playlist_id: i64,
    ordered_track_ids: Vec<i64>,
) -> Result<(), String> {
    let db = open_db(&app)?;
    db.reorder_playlist_tracks(playlist_id, &ordered_track_ids)
        .map_err(|e| e.to_string())
}
