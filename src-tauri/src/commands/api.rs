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
use crate::pairing::PairingRegistry;

/// API サーバーの設定キー: 有効フラグ。
pub const KEY_ENABLED: &str = "api_server_enabled";
/// API サーバーの設定キー: 待受ポート。
pub const KEY_PORT: &str = "api_server_port";
/// 既定ポート。
pub const DEFAULT_PORT: u16 = 8787;
/// API サーバーの設定キー: LAN 公開フラグ。
pub const KEY_LAN_ENABLED: &str = "api_lan_enabled";
/// API サーバーの設定キー: LAN アクセストークン。
pub const KEY_TOKEN: &str = "api_token";

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
    /// LAN 公開が有効かどうか。
    pub lan_enabled: bool,
    /// LAN トークン (lan_enabled=true のときのみ Some)。
    pub token: Option<String>,
    /// LAN 上の各 IPv4 アドレスで組み立てた URL 一覧。
    pub lan_urls: Vec<String>,
}

/// ランダムな 48 文字の hex トークンを生成する。
fn gen_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).unwrap_or_default();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// app_data_dir を取得する (setup / コマンド双方から使う想定)。
fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

/// 設定 (enabled, port, lan_enabled, token) を DB から読む。
fn read_full_config(app: &AppHandle) -> Result<(bool, u16, bool, Option<String>), String> {
    let db = open_db(app)?;
    let enabled = db.get_state(KEY_ENABLED).map_err(|e| e.to_string())?.map(|v| v == "true").unwrap_or(false);
    let port = db.get_state(KEY_PORT).map_err(|e| e.to_string())?.and_then(|v| v.parse::<u16>().ok()).unwrap_or(DEFAULT_PORT);
    let lan_enabled = db.get_state(KEY_LAN_ENABLED).map_err(|e| e.to_string())?.map(|v| v == "true").unwrap_or(false);
    let token = db.get_state(KEY_TOKEN).map_err(|e| e.to_string())?;
    Ok((enabled, port, lan_enabled, token))
}

/// 現在のサーバー状態を返す。設定値 + managed state の有無から組み立てる。
#[tauri::command]
pub fn get_api_server_status(
    app: AppHandle,
    server: State<'_, Mutex<Option<api::ServerControl>>>,
) -> Result<ApiServerStatus, String> {
    let (enabled, port, lan_enabled, token) = read_full_config(&app)?;
    let guard = server.lock().map_err(|e| e.to_string())?;
    let running = guard.is_some();
    let url = if running {
        Some(format!("http://127.0.0.1:{port}"))
    } else {
        None
    };
    // LAN IPv4 アドレスを列挙して URL を組み立てる。
    // - リンクローカル (169.254.x.x) とループバックを除外する。
    // - local_ip() で得た主 IP を先頭に並べ替える (フロントが [0] を推奨表示)。
    let lan_urls: Vec<String> = if running && lan_enabled {
        let primary_ip = local_ip_address::local_ip().ok();
        let mut addrs: Vec<std::net::Ipv4Addr> = local_ip_address::list_afinet_netifas()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(_, ip)| {
                if let std::net::IpAddr::V4(v4) = ip {
                    // ループバックとリンクローカル (169.254.x.x) を除外する。
                    if !v4.is_loopback() && !v4.is_link_local() {
                        return Some(v4);
                    }
                }
                None
            })
            .collect();
        // 主 IP が先頭に来るように並べ替える。
        if let Some(std::net::IpAddr::V4(primary_v4)) = primary_ip {
            if let Some(pos) = addrs.iter().position(|&a| a == primary_v4) {
                addrs.swap(0, pos);
            }
        }
        addrs.into_iter().map(|v4| format!("http://{}:{}", v4, port)).collect()
    } else {
        Vec::new()
    };
    let token_out = if lan_enabled { token } else { None };
    Ok(ApiServerStatus {
        enabled,
        running,
        port,
        url,
        lan_enabled,
        token: token_out,
        lan_urls,
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
    pairings: State<'_, PairingRegistry>,
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
        let (_, _, lan_enabled, token) = read_full_config(&app)?;
        match api::start(dir, port, app.clone(), lan_enabled, token, pairings.inner().clone()) {
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
    pairings: &PairingRegistry,
) -> Result<(), String> {
    let (enabled, port, lan_enabled, token) = read_full_config(app)?;
    if !enabled {
        return Ok(());
    }
    // LAN 有効でトークンが未生成の場合は生成して保存する。
    let token = if lan_enabled && token.is_none() {
        let new_token = gen_token();
        let db = open_db(app)?;
        db.set_state(KEY_TOKEN, &new_token).map_err(|e| e.to_string())?;
        Some(new_token)
    } else {
        token
    };
    let dir = app_data_dir(app)?;
    let ctrl = api::start(dir, port, app.clone(), lan_enabled, token, pairings.clone())?;
    let mut guard = server.lock().map_err(|e| e.to_string())?;
    *guard = Some(ctrl);
    Ok(())
}

/// LAN 公開の有効/無効を切り替えて、サーバーを再起動する。
#[tauri::command]
pub fn set_api_lan_enabled(
    app: AppHandle,
    server: State<'_, Mutex<Option<api::ServerControl>>>,
    pairings: State<'_, PairingRegistry>,
    enabled: bool,
) -> Result<ApiServerStatus, String> {
    // 1. 設定を永続化。
    {
        let db = open_db(&app)?;
        db.set_state(KEY_LAN_ENABLED, if enabled { "true" } else { "false" })
            .map_err(|e| e.to_string())?;
        // LAN 有効化時にトークンが未設定なら生成して保存。
        if enabled {
            let token = db.get_state(KEY_TOKEN).map_err(|e| e.to_string())?;
            if token.is_none() {
                let new_token = gen_token();
                db.set_state(KEY_TOKEN, &new_token).map_err(|e| e.to_string())?;
            }
        }
    }

    // 2. 既存ハンドルがあれば停止する。
    {
        let mut guard = server.lock().map_err(|e| e.to_string())?;
        if let Some(ctrl) = guard.take() {
            ctrl.stop();
        }
    }

    // 3. api_server_enabled が true なら再起動する。
    let (api_enabled, port, lan_enabled, token) = read_full_config(&app)?;
    if api_enabled {
        let dir = app_data_dir(&app)?;
        match api::start(dir, port, app.clone(), lan_enabled, token, pairings.inner().clone()) {
            Ok(ctrl) => {
                let mut guard = server.lock().map_err(|e| e.to_string())?;
                *guard = Some(ctrl);
            }
            Err(e) => return Err(e),
        }
    }

    get_api_server_status(app, server)
}

/// API トークンを再生成して、サーバーを再起動する。
#[tauri::command]
pub fn regenerate_api_token(
    app: AppHandle,
    server: State<'_, Mutex<Option<api::ServerControl>>>,
    pairings: State<'_, PairingRegistry>,
) -> Result<ApiServerStatus, String> {
    // 1. 新トークンを生成して永続化。
    {
        let db = open_db(&app)?;
        let new_token = gen_token();
        db.set_state(KEY_TOKEN, &new_token).map_err(|e| e.to_string())?;
    }

    // 2. 既存ハンドルがあれば停止する。
    {
        let mut guard = server.lock().map_err(|e| e.to_string())?;
        if let Some(ctrl) = guard.take() {
            ctrl.stop();
        }
    }

    // 3. api_server_enabled が true なら再起動する。
    let (api_enabled, port, lan_enabled, token) = read_full_config(&app)?;
    if api_enabled {
        let dir = app_data_dir(&app)?;
        match api::start(dir, port, app.clone(), lan_enabled, token, pairings.inner().clone()) {
            Ok(ctrl) => {
                let mut guard = server.lock().map_err(|e| e.to_string())?;
                *guard = Some(ctrl);
            }
            Err(e) => return Err(e),
        }
    }

    get_api_server_status(app, server)
}

/// 指定文字列 (URL など) から QR コードの SVG 文字列を生成して返す。
/// フロントが `<img src="data:image/svg+xml,...">` などとして表示する用途を想定。
#[tauri::command]
pub fn lan_qr_svg(data: String) -> Result<String, String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(data.as_bytes())
        .map_err(|e| format!("QR encode failed: {e}"))?;
    let svg_str = code
        .render::<svg::Color>()
        .min_dimensions(180, 180)
        .build();
    Ok(svg_str)
}
