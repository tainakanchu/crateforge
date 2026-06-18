//! 内蔵 API サーバーの起動 / 停止 / 状態取得コマンド。
//!
//! 設定は `app_state` テーブルに永続化する:
//!   - `api_server_enabled` : "true" / "false"
//!   - `api_server_port`    : 数値文字列 (既定 8787)
//! 稼働中の [`api::ServerControl`] は managed state (`Mutex<Option<ServerControl>>`)
//! に保持する。

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::api;
use crate::commands::library::open_db;

/// API サーバーの設定キー: 有効フラグ。
pub const KEY_ENABLED: &str = "api_server_enabled";
/// API サーバーの設定キー: 待受ポート。
pub const KEY_PORT: &str = "api_server_port";
/// 既定ポート。
pub const DEFAULT_PORT: u16 = 8787;

/// フロントへ返すサーバー状態。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerStatus {
    /// 設定上の有効フラグ (起動失敗していても enabled=true はあり得る)。
    pub enabled: bool,
    /// 実際に待受中か (managed state にハンドルがあるか)。
    pub running: bool,
    /// 設定上のポート。
    pub port: u16,
    /// running 時のみ `http://127.0.0.1:{port}`。
    pub url: Option<String>,
}

/// app_data_dir を取得する (setup / コマンド双方から使う想定)。
fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

/// 設定 (enabled, port) を DB から読む。未設定は (false, DEFAULT_PORT)。
fn read_config(app: &AppHandle) -> Result<(bool, u16), String> {
    let db = open_db(app)?;
    let enabled = db
        .get_state(KEY_ENABLED)
        .map_err(|e| e.to_string())?
        .map(|v| v == "true")
        .unwrap_or(false);
    let port = db
        .get_state(KEY_PORT)
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    Ok((enabled, port))
}

/// 現在のサーバー状態を返す。設定値 + managed state の有無から組み立てる。
#[tauri::command]
pub fn get_api_server_status(
    app: AppHandle,
    server: State<'_, Mutex<Option<api::ServerControl>>>,
) -> Result<ApiServerStatus, String> {
    let (enabled, port) = read_config(&app)?;
    let guard = server.lock().map_err(|e| e.to_string())?;
    let running = guard.is_some();
    let url = if running {
        Some(format!("http://127.0.0.1:{port}"))
    } else {
        None
    };
    Ok(ApiServerStatus {
        enabled,
        running,
        port,
        url,
    })
}

/// 有効フラグ / ポートを設定して反映する。
/// - 設定値は常に永続化する。
/// - 既存の稼働ハンドルがあれば必ず停止する。
/// - enabled なら新たに bind + serve を開始し managed state に格納する。
///   bind 失敗 (ポート使用中など) はエラー文字列を返す (enabled の保存自体は済んでいる)。
#[tauri::command]
pub fn set_api_server_config(
    app: AppHandle,
    server: State<'_, Mutex<Option<api::ServerControl>>>,
    enabled: bool,
    port: u16,
) -> Result<ApiServerStatus, String> {
    // 1. 設定を永続化。
    {
        let db = open_db(&app)?;
        db.set_state(KEY_ENABLED, if enabled { "true" } else { "false" })
            .map_err(|e| e.to_string())?;
        db.set_state(KEY_PORT, &port.to_string())
            .map_err(|e| e.to_string())?;
    }

    // 2. 既存ハンドルがあれば停止する。
    {
        let mut guard = server.lock().map_err(|e| e.to_string())?;
        if let Some(ctrl) = guard.take() {
            ctrl.stop();
        }
    }

    // 3. enabled なら起動する。失敗時は running=false でエラーを返す。
    if enabled {
        let dir = app_data_dir(&app)?;
        match api::start(dir, port, app.clone()) {
            Ok(ctrl) => {
                let mut guard = server.lock().map_err(|e| e.to_string())?;
                *guard = Some(ctrl);
            }
            Err(e) => return Err(e),
        }
    }

    // 4. 反映後の状態を返す。
    get_api_server_status(app, server)
}

/// アプリ起動時に「前回 enabled」だった場合へ自動起動する (setup から呼ぶ)。
/// 失敗は非致命で、呼び出し側でログするだけに留める。
pub fn start_if_enabled(
    app: &AppHandle,
    server: &Mutex<Option<api::ServerControl>>,
) -> Result<(), String> {
    let (enabled, port) = read_config(app)?;
    if !enabled {
        return Ok(());
    }
    let dir = app_data_dir(app)?;
    let ctrl = api::start(dir, port, app.clone())?;
    let mut guard = server.lock().map_err(|e| e.to_string())?;
    *guard = Some(ctrl);
    Ok(())
}
