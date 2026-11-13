use tauri::AppHandle;

use crate::commands::library::open_db;
use crate::converter;
use crate::ffmpeg;
use crate::models::ConvertRequest;

/// 選択トラックを別フォーマットへ変換する。重い処理なのでバックグラウンドで実行し、
/// 進捗は `convert-progress` イベントで配信する。
/// 変換前に ffmpeg を解決し、無ければ（Windows のみ）自動取得する。
#[tauri::command]
pub async fn convert_tracks(app: AppHandle, request: ConvertRequest) -> Result<(), String> {
    if request.output_dir.trim().is_empty() {
        return Err("Output folder is required".to_string());
    }
    if request.track_ids.is_empty() {
        return Err("No tracks selected".to_string());
    }
    // ffmpeg を解決（未取得なら DL）。失敗時はここで UI へエラーを返す。
    let ffmpeg = ffmpeg::ensure(&app).await?;
    std::thread::spawn(move || match open_db(&app) {
        Ok(db) => {
            if let Err(e) = converter::convert_tracks(&app, &db, request, ffmpeg) {
                eprintln!("convert_tracks failed: {}", e);
            }
        }
        Err(e) => eprintln!("convert_tracks: open db failed: {}", e),
    });
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertReplaceRequest {
    pub track_ids: Vec<i64>,
    #[serde(flatten)]
    pub options: crate::converter::in_place::InPlaceOptions,
}

/// 選択トラックを変換し、同じ曲のまま新しいファイルへ置き換える (バックグラウンド実行)。
/// 進捗は `convert-replace-progress` イベントで配信し、ジョブ ID を返す。
#[tauri::command]
pub async fn convert_replace_tracks(
    app: AppHandle,
    request: ConvertReplaceRequest,
) -> Result<String, String> {
    if request.track_ids.is_empty() {
        return Err("No tracks selected".to_string());
    }
    let ffmpeg = ffmpeg::ensure(&app).await?;
    let db_app = app.clone();
    let job_id = converter::jobs::spawn(
        request.track_ids,
        request.options,
        ffmpeg,
        move || open_db(&db_app),
        move |ev| {
            use tauri::Emitter;
            let _ = app.emit("convert-replace-progress", ev);
        },
    );
    Ok(job_id)
}
