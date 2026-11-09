use tauri::AppHandle;

use crate::commands::library::open_db;
use crate::db::playlists::SMART_PLAYLIST_EDIT_ERROR;
use crate::db::Database;
use crate::models::{Playlist, SmartCriteria, Track};

/// スマートプレイリストの曲目は直接編集させない (書いても条件の評価で無視されるため)。
fn ensure_tracks_editable(db: &Database, playlist_id: i64) -> Result<(), String> {
    if db.has_smart_criteria(playlist_id).map_err(|e| e.to_string())? {
        return Err(SMART_PLAYLIST_EDIT_ERROR.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_playlists(app: AppHandle) -> Result<Vec<Playlist>, String> {
    let db = open_db(&app)?;
    db.get_playlists().map_err(|e| e.to_string())
}

// ===== Smart playlists =====

#[tauri::command]
pub fn create_smart_playlist(
    app: AppHandle,
    name: String,
    criteria: SmartCriteria,
) -> Result<Playlist, String> {
    let db = open_db(&app)?;
    db.create_smart_playlist(&name, &criteria)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_smart_criteria(
    app: AppHandle,
    playlist_id: i64,
    criteria: SmartCriteria,
) -> Result<(), String> {
    let db = open_db(&app)?;
    db.set_smart_criteria(playlist_id, &criteria)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_smart_criteria(
    app: AppHandle,
    playlist_id: i64,
) -> Result<Option<SmartCriteria>, String> {
    let db = open_db(&app)?;
    db.get_smart_criteria(playlist_id)
        .map_err(|e| e.to_string())
}

/// 既存ライブラリ向け: iTunes XML (複数可・先頭優先) のスマートプレイリスト条件を、
/// `Playlist Persistent ID` が一致するプレイリストへ復元する。曲・プレイリスト自体は取り込まない。
/// `overwrite` が false なら既に条件があるプレイリストは変更しない。あわせて曲の Grouping を
/// (DB 側が空の曲だけ) XML の値で埋める。
#[tauri::command(async)]
pub fn restore_itunes_smart_playlists(
    app: AppHandle,
    paths: Vec<String>,
    overwrite: bool,
) -> Result<crate::itunes_xml::smart_restore::SmartRestoreReport, String> {
    let db = open_db(&app)?;
    crate::itunes_xml::smart_restore::restore_from_files(&db, &paths, overwrite)
}

#[tauri::command(async)]
pub fn get_smart_playlist_tracks(
    app: AppHandle,
    playlist_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
    query: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = open_db(&app)?;
    db.get_smart_playlist_tracks_filtered(
        playlist_id,
        query.as_deref(),
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        sort_field.as_deref(),
        sort_order.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_playlist_tracks(
    app: AppHandle,
    playlist_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
    query: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = open_db(&app)?;
    db.get_playlist_tracks_filtered(
        playlist_id,
        query.as_deref(),
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
    ensure_tracks_editable(&db, playlist_id)?;
    // ライブラリ外の一時再生曲 (負の ID) は DB に行が無いので、プレイリストには入れない。
    let track_ids: Vec<i64> = track_ids
        .into_iter()
        .filter(|&id| !crate::transient::is_transient_id(id))
        .collect();
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
    ensure_tracks_editable(&db, playlist_id)?;
    db.remove_track_from_playlist(playlist_id, track_id)
        .map_err(|e| e.to_string())
}

/// 選択中の複数曲をまとめてプレイリストから外す (1 トランザクション)。外した行数を返す。
#[tauri::command]
pub fn remove_tracks_from_playlist(
    app: AppHandle,
    playlist_id: i64,
    track_ids: Vec<i64>,
) -> Result<usize, String> {
    let db = open_db(&app)?;
    ensure_tracks_editable(&db, playlist_id)?;
    db.remove_tracks_from_playlist(playlist_id, &track_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_playlist_tracks(
    app: AppHandle,
    playlist_id: i64,
    ordered_track_ids: Vec<i64>,
) -> Result<(), String> {
    let db = open_db(&app)?;
    ensure_tracks_editable(&db, playlist_id)?;
    db.reorder_playlist_tracks(playlist_id, &ordered_track_ids)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// スマート条件のあるプレイリストは曲目の編集コマンドを拒否する。通常プレイリストは通す。
    #[test]
    fn smart_playlist_tracks_are_not_editable() {
        let db = Database::open_memory().unwrap();
        let normal = db.create_playlist("Normal", None, false).unwrap();
        let smart = db
            .create_smart_playlist(
                "Smart",
                &SmartCriteria {
                    match_all: true,
                    rules: vec![],
                    groups: vec![],
                    limit: None,
                    sort_by: None,
                    sort_desc: false,
                    then_by: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(ensure_tracks_editable(&db, normal.playlist_id), Ok(()));
        assert_eq!(
            ensure_tracks_editable(&db, smart.playlist_id),
            Err(SMART_PLAYLIST_EDIT_ERROR.to_string())
        );
    }
}
