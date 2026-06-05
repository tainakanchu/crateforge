use base64::Engine;
use tauri::AppHandle;

use crate::artwork;
use crate::commands::library::open_db;
use crate::db::Database;

/// 指定トラック群のカバーアートを `data` で差し替える。成功件数を返す。
fn apply(db: &Database, track_ids: &[i64], data: Vec<u8>) -> usize {
    let mut ok = 0usize;
    for id in track_ids {
        if let Ok(Some(t)) = db.get_track_by_track_id(*id) {
            if let Some(path) = t.location_path {
                if !path.is_empty() && artwork::set_picture(&path, data.clone()).is_ok() {
                    ok += 1;
                }
            }
        }
    }
    ok
}

/// base64 画像データ (クリップボードからの PNG など) をカバーアートに設定する。
#[tauri::command]
pub fn set_artwork_from_data(
    app: AppHandle,
    track_ids: Vec<i64>,
    data_base64: String,
) -> Result<usize, String> {
    let db = open_db(&app)?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("Invalid image data: {}", e))?;
    Ok(apply(&db, &track_ids, data))
}

/// 画像ファイルを読み込んでカバーアートに設定する。
#[tauri::command]
pub fn set_artwork_from_file(
    app: AppHandle,
    track_ids: Vec<i64>,
    path: String,
) -> Result<usize, String> {
    let db = open_db(&app)?;
    let data = std::fs::read(&path).map_err(|e| format!("Reading image failed: {}", e))?;
    Ok(apply(&db, &track_ids, data))
}
