//! デバイス別トークンの永続化と「有効トークン集合」。
//!
//! ## 背景
//! 従来は LAN API の認証に単一の共有トークン (`app_state` の `api_token`) を使い、
//! 承認した全端末へ同じトークンを配っていた。これだと 1 端末を失効させる手段がなく、
//! 1 つ漏れると全端末を作り直すしかない。
//!
//! ## 方針 (後方互換を保つ)
//! - 承認のたびに「端末ごとの新規トークン」を発行し、`app_state` の `api_devices`
//!   キーへ JSON 配列で永続化する (新テーブル不要)。
//! - 認証は **有効トークン集合** ([`ValidTokens`]) で行う。集合には
//!   旧来の単一共有トークン (`api_token`) **と** 全デバイストークンの双方を入れる。
//!   これにより、既に共有トークンで接続中のクライアントは切れない (後方互換)。
//! - 端末ごとに [`remove_device`] で個別失効できる。
//!
//! [`ValidTokens`] は `Arc<Mutex<HashSet<String>>>` を内包し、axum ハンドラ
//! ([`crate::api::ApiState`]) と Tauri コマンドで同じ実体を共有する。承認・失効は
//! サーバー再起動を待たず即座に反映される。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::db::Database;

/// `app_state` テーブルでデバイス配列 (JSON) を保持するキー。
pub const KEY_DEVICES: &str = "api_devices";

/// 承認済み 1 端末ぶんの記録。`token` も含む (DB 永続化用なので外部へは返さない)。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Device {
    /// ランダム生成の一意 ID (失効操作のキー)。
    pub id: String,
    /// クライアントが申告した端末名 (任意)。
    #[serde(rename = "deviceName")]
    pub device_name: Option<String>,
    /// クライアントが申告したプラットフォーム (任意)。
    pub platform: Option<String>,
    /// この端末専用の 48 文字 hex トークン。
    pub token: String,
    /// 承認日時 (ISO8601)。
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// 管理 UI へ返すデバイス情報。`token` は **含めない** (漏洩防止)。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub created_at: String,
}

impl From<&Device> for DeviceInfo {
    fn from(d: &Device) -> Self {
        DeviceInfo {
            id: d.id.clone(),
            device_name: d.device_name.clone(),
            platform: d.platform.clone(),
            created_at: d.created_at.clone(),
        }
    }
}

/// 認証で参照する有効トークン集合 (legacy 共有トークン + 全デバイストークン)。
/// axum ハンドラと Tauri コマンドで `Arc` を共有し、承認/失効を即時反映する。
#[derive(Clone, Default)]
pub struct ValidTokens(pub Arc<Mutex<HashSet<String>>>);

impl ValidTokens {
    /// 集合へ 1 件追加する (承認直後の即時有効化に使う)。
    pub fn insert(&self, token: String) {
        let mut set = self.0.lock().unwrap_or_else(|p| p.into_inner());
        set.insert(token);
    }

    /// 集合から 1 件削除する (失効/再生成時に使う)。
    pub fn remove(&self, token: &str) {
        let mut set = self.0.lock().unwrap_or_else(|p| p.into_inner());
        set.remove(token);
    }

    /// 与えたトークンが有効か。
    pub fn contains(&self, token: &str) -> bool {
        let set = self.0.lock().unwrap_or_else(|p| p.into_inner());
        set.contains(token)
    }

    /// 集合が空か (= 有効トークン未設定。LAN 認証は FORBIDDEN になる)。
    pub fn is_empty(&self) -> bool {
        let set = self.0.lock().unwrap_or_else(|p| p.into_inner());
        set.is_empty()
    }
}

/// DB の有効トークン集合を作り直す。`legacy` (`api_token`) があれば追加し、
/// さらに全デバイストークンを追加する。サーバー起動時/再起動時に呼び、
/// `app_state` を単一の真実の源として `ValidTokens` を同期する。
pub fn reload_valid_tokens(db: &Database, valid: &ValidTokens) {
    let mut set = valid.0.lock().unwrap_or_else(|p| p.into_inner());
    set.clear();
    if let Ok(Some(legacy)) = db.get_state(crate::commands::api::KEY_TOKEN) {
        if !legacy.is_empty() {
            set.insert(legacy);
        }
    }
    for token in all_device_tokens(db) {
        set.insert(token);
    }
}

/// DB からデバイス配列を読む。未設定 / パース失敗時は空配列。
pub fn load_devices(db: &Database) -> Vec<Device> {
    match db.get_state(KEY_DEVICES) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// デバイス配列を DB に保存する (JSON 文字列)。
pub fn save_devices(db: &Database, devices: &[Device]) -> Result<(), String> {
    let json = serde_json::to_string(devices).map_err(|e| e.to_string())?;
    db.set_state(KEY_DEVICES, &json).map_err(|e| e.to_string())
}

/// 事前に生成済みのトークンを指定してデバイスを永続化する。
/// `approve_pairing` が「approve_by_code 成功後にのみ永続化」するために使う。
pub fn add_device_with_token(
    db: &Database,
    device_name: Option<String>,
    platform: Option<String>,
    token: String,
) -> Result<(), String> {
    let device = Device {
        id: gen_id(),
        device_name,
        platform,
        token,
        created_at: now_iso8601(),
    };
    let mut devices = load_devices(db);
    devices.push(device);
    save_devices(db, &devices)
}

/// 指定 ID のデバイスを削除する。削除できたら、その端末のトークンを返す
/// (呼び出し側が有効トークン集合からも除去するため)。見つからなければ `None`。
pub fn remove_device(db: &Database, id: &str) -> Result<Option<String>, String> {
    let mut devices = load_devices(db);
    let mut removed_token = None;
    devices.retain(|d| {
        if d.id == id {
            removed_token = Some(d.token.clone());
            false
        } else {
            true
        }
    });
    save_devices(db, &devices)?;
    Ok(removed_token)
}

/// 全デバイスのトークン一覧。
pub fn all_device_tokens(db: &Database) -> Vec<String> {
    load_devices(db).into_iter().map(|d| d.token).collect()
}

/// ランダムな 48 文字 hex トークン (`commands::api::gen_token` と同仕様)。
pub fn gen_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).unwrap_or_default();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// ランダムな 32 文字 hex ID (UUID 風)。
fn gen_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).unwrap_or_default();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 現在時刻を ISO8601 (UTC) で返す。既存コードと同じ書式に揃える。
fn now_iso8601() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

// ────────────────────────────── unit tests ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// add → all_tokens / load の往復で、トークン・メタ・ID・日時が入る。
    #[test]
    fn test_add_and_all_tokens() {
        let db = Database::open_memory().unwrap();
        assert!(all_device_tokens(&db).is_empty());

        let tok = gen_token();
        add_device_with_token(
            &db,
            Some("Phone".into()),
            Some("android".into()),
            tok.clone(),
        )
        .unwrap();
        assert_eq!(tok.len(), 48, "token は 48 文字 hex");

        let tokens = all_device_tokens(&db);
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0], tok);

        let devices = load_devices(&db);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_name.as_deref(), Some("Phone"));
        assert_eq!(devices[0].platform.as_deref(), Some("android"));
        assert!(!devices[0].id.is_empty());
        assert!(!devices[0].created_at.is_empty());
    }

    /// remove は対象トークンを返し、集合からも消える。未知 ID は None。
    #[test]
    fn test_remove_device() {
        let db = Database::open_memory().unwrap();
        let t1 = gen_token();
        add_device_with_token(&db, Some("A".into()), None, t1.clone()).unwrap();
        add_device_with_token(&db, Some("B".into()), None, gen_token()).unwrap();

        let id1 = load_devices(&db)
            .into_iter()
            .find(|d| d.token == t1)
            .unwrap()
            .id;
        let removed = remove_device(&db, &id1).unwrap();
        assert_eq!(removed.as_deref(), Some(t1.as_str()));

        let tokens = all_device_tokens(&db);
        assert_eq!(tokens.len(), 1);
        assert!(!tokens.contains(&t1));

        // 存在しない ID は None (保存は冪等)。
        assert!(remove_device(&db, "nonexistent").unwrap().is_none());
    }

    /// 複数デバイスのトークンは別物 (毎回新規生成)。
    #[test]
    fn test_tokens_are_unique() {
        let db = Database::open_memory().unwrap();
        let a = gen_token();
        add_device_with_token(&db, None, None, a.clone()).unwrap();
        let b = gen_token();
        add_device_with_token(&db, None, None, b.clone()).unwrap();
        assert_ne!(a, b);
        assert_eq!(all_device_tokens(&db).len(), 2);
    }

    /// reload_valid_tokens は legacy + 全デバイストークンを集合へ反映する。
    #[test]
    fn test_reload_valid_tokens() {
        let db = Database::open_memory().unwrap();
        let dev = gen_token();
        add_device_with_token(&db, Some("X".into()), None, dev.clone()).unwrap();
        db.set_state(crate::commands::api::KEY_TOKEN, "legacytoken")
            .unwrap();

        let valid = ValidTokens::default();
        reload_valid_tokens(&db, &valid);
        assert!(valid.contains("legacytoken"));
        assert!(valid.contains(&dev));
        assert!(!valid.contains("unknown"));

        // デバイスを失効させて reload すると、そのトークンは集合から消える。
        let id = load_devices(&db).into_iter().next().unwrap().id;
        remove_device(&db, &id).unwrap();
        reload_valid_tokens(&db, &valid);
        assert!(valid.contains("legacytoken"));
        assert!(!valid.contains(&dev));
    }

    /// ValidTokens の基本操作。
    #[test]
    fn test_valid_tokens_set_ops() {
        let vt = ValidTokens::default();
        assert!(vt.is_empty());
        vt.insert("abc".into());
        assert!(vt.contains("abc"));
        assert!(!vt.contains("xyz"));
        vt.remove("abc");
        assert!(!vt.contains("abc"));
        assert!(vt.is_empty());
    }
}
