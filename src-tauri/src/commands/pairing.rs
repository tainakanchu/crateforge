//! デバイスペアリング Tauri コマンド。
//!
//! デスクトップ側ユーザーが TV/モバイル端末のペアリングコードを承認するための操作。
//! [`crate::pairing::PairingRegistry`] は managed state として Tauri から取得する。

use tauri::{AppHandle, State};

use crate::pairing::{PairingInfo, PairingRegistry};

/// TV/モバイルが画面に表示したコードを入力して承認する。
///
/// - `code`: 6 文字のペアリングコード（大小文字・前後空白は正規化する）。
/// - 承認成功 → `Ok(true)`。
/// - コードが見つからない / 有効期限切れ → `Ok(false)`。
/// - LAN トークンが未設定 (LAN 無効) → `Err("LAN API/トークンが無効です")`。
#[tauri::command]
pub fn approve_pairing(
    app: AppHandle,
    pairings: State<'_, PairingRegistry>,
    code: String,
) -> Result<bool, String> {
    // 現在の LAN トークンを取得する。
    // commands::api の DB アクセス経由で読む (他のコマンドと同じパターン)。
    use crate::commands::library::open_db;
    let db = open_db(&app)?;
    let token = db
        .get_state(crate::commands::api::KEY_TOKEN)
        .map_err(|e| e.to_string())?;

    let token = match token {
        Some(t) => t,
        None => return Err("LAN API/トークンが無効です".to_string()),
    };

    let ok = pairings.approve_by_code(&code, token);
    Ok(ok)
}

/// 未承認・有効期限内のペアリングセッション一覧を返す。
/// デスクトップ UI で「承認待ち端末」をリスト表示するために使う。
#[tauri::command]
pub fn list_pending_pairings(
    pairings: State<'_, PairingRegistry>,
) -> Result<Vec<PairingInfo>, String> {
    Ok(pairings.pending_list())
}
