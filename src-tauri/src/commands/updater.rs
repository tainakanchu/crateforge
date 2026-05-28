use crate::updater;

#[tauri::command]
pub async fn check_for_update() -> Result<updater::UpdateInfo, String> {
    updater::check_for_update().await
}
