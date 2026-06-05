use crate::updater;

#[tauri::command]
pub async fn check_for_update() -> Result<updater::UpdateInfo, String> {
    updater::check_for_update().await
}

/// インストーラを直接ダウンロードして起動する (リリースページを開く代わり)。
#[tauri::command]
pub async fn download_and_run_update(url: String) -> Result<String, String> {
    updater::download_and_run(&url).await
}
