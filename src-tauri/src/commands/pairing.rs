//! デバイスペアリング Tauri コマンド。
//!
//! デスクトップ側ユーザーが TV/モバイル端末のペアリングコードを承認するための操作。
//! [`crate::pairing::PairingRegistry`] は managed state として Tauri から取得する。

use tauri::{AppHandle, State};

use crate::commands::library::open_db;
use crate::devices::{DeviceInfo, DeviceRole, ValidTokens};
use crate::pairing::{PairingInfo, PairingRegistry};

/// TV/モバイルが画面に表示したコードを入力して承認する。
///
/// 承認のたびに「その端末専用」の新規トークンを発行・永続化し、有効トークン集合へ
/// 加える。これにより端末ごとに個別失効でき、1 つ漏れても他端末は無事
/// (従来の単一共有トークンも有効なまま = 後方互換)。
///
/// - `code`: 6 文字のペアリングコード（大小文字・前後空白は正規化する）。
/// - `role`: 省略時は従来相当の `remote`。
/// - 承認成功 → `Ok(true)`。
/// - コードが見つからない / 有効期限切れ → `Ok(false)` (トークンは発行しない)。
#[tauri::command]
pub fn approve_pairing(
    app: AppHandle,
    pairings: State<'_, PairingRegistry>,
    valid_tokens: State<'_, ValidTokens>,
    code: String,
    role: Option<DeviceRole>,
) -> Result<bool, String> {
    let role = role.unwrap_or_default();
    // 1. 該当する保留中ペアリングの申告メタ (端末名/プラットフォーム) を取得する。
    //    見つからなければ承認対象が無いので、トークンは一切発行せず false を返す。
    let (device_name, platform) = match pairings.peek_pending(&code) {
        Some(meta) => meta,
        None => return Ok(false),
    };

    // 2. この端末専用の新トークンをあらかじめ生成する (永続化はまだしない)。
    let new_token = crate::devices::gen_token();

    // 3. ペアリングを承認する (poll で端末がこのトークンを受領する)。
    //    false の場合は期限切れ/二重承認なので、永続化・集合追加はしない。
    let approved = pairings.approve_by_code(&code, new_token.clone());

    // 4. 承認が成功したときだけ DB へ永続化し、稼働中サーバーの有効集合へ加える。
    //    これにより approve_by_code が false のとき「幽霊トークン」が残らない。
    if approved {
        let db = open_db(&app)?;
        crate::devices::add_device_with_token(&db, device_name, platform, new_token.clone(), role)?;
        valid_tokens.insert_with_role(new_token, role);
    }

    Ok(approved)
}

/// 未承認・有効期限内のペアリングセッション一覧を返す。
/// デスクトップ UI で「承認待ち端末」をリスト表示するために使う。
#[tauri::command]
pub fn list_pending_pairings(
    pairings: State<'_, PairingRegistry>,
) -> Result<Vec<PairingInfo>, String> {
    Ok(pairings.pending_list())
}

/// 承認済み (ペアリング済み) デバイス一覧を返す。トークンは **含めない**。
/// デスクトップ UI で「接続済み端末」を管理表示するために使う。
#[tauri::command]
pub fn list_paired_devices(app: AppHandle) -> Result<Vec<DeviceInfo>, String> {
    let db = open_db(&app)?;
    Ok(crate::devices::load_devices(&db)
        .iter()
        .map(DeviceInfo::from)
        .collect())
}

/// 指定 ID のデバイスを失効させる (DB と有効トークン集合の双方から削除)。
/// これにより、その端末のトークンだけが即座に無効化され、他端末は影響を受けない。
/// 既に存在しない ID でもエラーにはしない (冪等)。
#[tauri::command]
pub fn revoke_device(
    app: AppHandle,
    valid_tokens: State<'_, ValidTokens>,
    id: String,
) -> Result<(), String> {
    let db = open_db(&app)?;
    if let Some(token) = crate::devices::remove_device(&db, &id)? {
        valid_tokens.remove(&token);
    }
    Ok(())
}
