//! フォント関連の Tauri コマンド。

use tauri::AppHandle;

use crate::commands::library::open_db;
use crate::fonts;


/// CJK フォントの状態。
#[derive(serde::Serialize)]
pub struct CjkFontStatus {
    pub installed: bool,
}

/// システムにインストールされているフォントファミリー名の一覧を返す。
#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    Ok(fonts::list_families())
}

/// 設定済みの UI フォントを返す。未設定なら `None`。
#[tauri::command]
pub fn get_ui_font(app: AppHandle) -> Result<Option<String>, String> {
    let db = open_db(&app)?;
    db.get_state("ui_font").map_err(|e| e.to_string())
}

/// UI フォントを設定する。`None` を渡すとデフォルトにリセット。
#[tauri::command]
pub fn set_ui_font(app: AppHandle, font: Option<String>) -> Result<(), String> {
    let db = open_db(&app)?;
    match font {
        Some(f) => db.set_state("ui_font", &f).map_err(|e| e.to_string()),
        None => db.set_state("ui_font", "").map_err(|e| e.to_string()),
    }
}

/// CJK フォントのインストール状態を返す。
#[tauri::command]
pub fn cjk_font_status(app: AppHandle) -> Result<CjkFontStatus, String> {
    Ok(CjkFontStatus {
        installed: fonts::is_installed(&app),
    })
}

/// CJK フォントをダウンロードする。進捗は `cjk-font-progress` イベントで配信。
#[tauri::command]
pub async fn download_cjk_font(app: AppHandle) -> Result<(), String> {
    fonts::download(app).await?;
    Ok(())
}
