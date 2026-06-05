use tauri::AppHandle;

use crate::commands::library::open_db;
use crate::converter;
use crate::models::ConvertRequest;

/// 選択トラックを別フォーマットへ変換する。重い処理なのでバックグラウンドで実行し、
/// 進捗は `convert-progress` イベントで配信する。
#[tauri::command]
pub fn convert_tracks(app: AppHandle, request: ConvertRequest) -> Result<(), String> {
    if request.output_dir.trim().is_empty() {
        return Err("Output folder is required".to_string());
    }
    if request.track_ids.is_empty() {
        return Err("No tracks selected".to_string());
    }
    std::thread::spawn(move || match open_db(&app) {
        Ok(db) => {
            if let Err(e) = converter::convert_tracks(&app, &db, request) {
                eprintln!("convert_tracks failed: {}", e);
            }
        }
        Err(e) => eprintln!("convert_tracks: open db failed: {}", e),
    });
    Ok(())
}
