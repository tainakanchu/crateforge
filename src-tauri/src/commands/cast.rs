//! 再生先 (このコンピューター / Google Cast) の選択と Cast 端末一覧のコマンド。
//! 契約は `docs/cast/design.md` §5。失敗は `"<CODE>: <message>"` 文字列で返す。

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::cast::discovery::CastDiscovery;
use crate::cast::{CastDevice, CastError, CastErrorCode, CastStatus};
use crate::playback_target::PlaybackCoordinator;

/// `set_playback_target` の引数。`deviceName` は端末一覧から引くので受け取らない。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TargetRequest {
    Local,
    GoogleCast { device_id: String },
}

fn coordinator(app: &AppHandle) -> PlaybackCoordinator {
    app.state::<PlaybackCoordinator>().inner().clone()
}

/// 見つかっている Cast 端末。初回呼び出しで mDNS の探索を始める。
#[tauri::command]
pub fn list_cast_devices(
    discovery: tauri::State<'_, CastDiscovery>,
) -> Result<Vec<CastDevice>, String> {
    discovery.ensure_started()?;
    Ok(discovery.devices())
}

/// 一覧を捨てて探索をやり直す (UI の「再検索」)。
#[tauri::command]
pub fn refresh_cast_devices(
    discovery: tauri::State<'_, CastDiscovery>,
) -> Result<Vec<CastDevice>, String> {
    discovery.restart()?;
    Ok(discovery.devices())
}

#[tauri::command]
pub fn get_cast_status(app: AppHandle) -> CastStatus {
    coordinator(&app).status()
}

#[tauri::command]
pub async fn set_playback_target(
    app: AppHandle,
    target: TargetRequest,
) -> Result<CastStatus, String> {
    let coord = coordinator(&app);
    match target {
        TargetRequest::Local => coord.switch_to_local(false).await,
        TargetRequest::GoogleCast { device_id } => {
            let device = app
                .state::<CastDiscovery>()
                .get(&device_id)
                .ok_or_else(|| {
                    String::from(CastError::new(
                        CastErrorCode::DeviceNotFound,
                        "Cast 端末が見つかりません。一覧を再検索してください",
                    ))
                })?;
            coord.connect_cast(device).await.map_err(String::from)
        }
    }
}

/// Cast を止めてこのコンピューターへ戻す。曲と位置は一時停止状態で引き継ぐ。
#[tauri::command]
pub async fn disconnect_cast(app: AppHandle) -> Result<CastStatus, String> {
    coordinator(&app).switch_to_local(true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_request_parses_frontend_shape() {
        let local: TargetRequest = serde_json::from_str(r#"{"type":"local"}"#).unwrap();
        assert_eq!(local, TargetRequest::Local);
        let cast: TargetRequest =
            serde_json::from_str(r#"{"type":"googleCast","deviceId":"abc"}"#).unwrap();
        assert_eq!(
            cast,
            TargetRequest::GoogleCast {
                device_id: "abc".into()
            }
        );
    }
}
