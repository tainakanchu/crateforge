//! デバイスペアリング レジストリ。
//!
//! TV/モバイル端末（クライアント）がトークンを知らずに LAN API へ接続できるようにするための
//! ペアリング機構。フロー:
//!   1. クライアントが POST /api/pair/start を叩く → session + code が返る。
//!   2. クライアントはコードを画面に表示し、GET /api/pair/poll?session=<id> を繰り返す。
//!   3. デスクトップ側ユーザーがコードを入力して承認 (`approve_pairing` コマンド)。
//!   4. poll が `approved` + token を返す → クライアントは以後そのトークンで LAN API を叩く。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 1 ペアリングセッションの状態。
#[derive(Clone, Debug)]
pub struct Pairing {
    /// 乱数由来の人間向け短コード（大文字 6 文字、曖昧文字除外）。
    pub code: String,
    /// デスクトップ側ユーザーが承認したか。
    pub approved: bool,
    /// 承認済みならトークンが入る。
    pub token: Option<String>,
    /// 作成日時（有効期限チェック用）。
    pub created_at: Instant,
}

/// ペアリングセッション一覧を保持するレジストリ。`Arc<Mutex<...>>` でスレッド間共有。
#[derive(Clone, Debug, Default)]
pub struct PairingRegistry(pub Arc<Mutex<HashMap<String, Pairing>>>);

impl PairingRegistry {
    /// 新規セッションを作成する。
    /// `session_id` (UUID 相当のランダム文字列) と人間向けの `code` (6 文字) を返す。
    pub fn create_session(&self) -> (String, String) {
        let session_id = gen_session_id();
        let code = gen_code();
        let pairing = Pairing {
            code: code.clone(),
            approved: false,
            token: None,
            created_at: Instant::now(),
        };
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        // 古いエントリを掃除してから追加する。
        prune(&mut map);
        map.insert(session_id.clone(), pairing);
        (session_id, code)
    }

    /// `code` に一致するセッションを承認する。
    /// 見つかれば `approved = true` + `token = Some(token)` をセットして `true` を返す。
    /// 見つからない場合・有効期限切れの場合は `false`。
    pub fn approve_by_code(&self, code: &str, token: String) -> bool {
        let code_normalized = code.trim().to_uppercase();
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        prune(&mut map);
        for pairing in map.values_mut() {
            if pairing.code == code_normalized && !pairing.approved {
                pairing.approved = true;
                pairing.token = Some(token);
                return true;
            }
        }
        false
    }

    /// `session_id` でポーリングする。
    /// - `None` → セッション不明 or 有効期限切れ。
    /// - `Some((false, None))` → pending。
    /// - `Some((true, Some(token)))` → approved。
    pub fn poll(&self, session_id: &str) -> Option<(bool, Option<String>)> {
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        prune(&mut map);
        map.get(session_id).map(|p| (p.approved, p.token.clone()))
    }

    /// 未承認 + 有効期限内のセッション一覧を返す（デスクトップ UI 向け）。
    pub fn pending_list(&self) -> Vec<PairingInfo> {
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        prune(&mut map);
        map.values()
            .filter(|p| !p.approved)
            .map(|p| PairingInfo {
                code: p.code.clone(),
                age_secs: p.created_at.elapsed().as_secs(),
            })
            .collect()
    }
}

/// `list_pending_pairings` コマンドが返すエントリ。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub code: String,
    pub age_secs: u64,
}

/// 有効期限 (10 分)。
const EXPIRY: Duration = Duration::from_secs(600);

/// 古いエントリをまとめて削除する。
fn prune(map: &mut HashMap<String, Pairing>) {
    map.retain(|_, p| p.created_at.elapsed() < EXPIRY);
}

/// ランダムなセッション ID (32 文字 hex)。
fn gen_session_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).unwrap_or_default();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 人間向け 6 文字コード（曖昧文字 0,O,I,L を除外したアルファベット大文字 + 数字）。
const SAFE_CHARS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn gen_code() -> String {
    let mut bytes = [0u8; 6];
    getrandom::getrandom(&mut bytes).unwrap_or_default();
    bytes
        .iter()
        .map(|b| {
            let idx = (*b as usize) % SAFE_CHARS.len();
            SAFE_CHARS[idx] as char
        })
        .collect()
}

// ────────────────────────────── unit tests ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// create → poll(pending) → approve(by code) → poll(approved + token)
    #[test]
    fn test_create_poll_approve_poll() {
        let reg = PairingRegistry::default();

        // 1. セッション作成。
        let (session, code) = reg.create_session();
        assert!(!session.is_empty());
        assert_eq!(code.len(), 6);

        // 2. poll: まだ pending。
        let result = reg.poll(&session);
        assert_eq!(result, Some((false, None)));

        // 3. approve: コードで承認。
        let tok = "my-secret-token".to_string();
        let ok = reg.approve_by_code(&code, tok.clone());
        assert!(ok);

        // 4. poll: approved + token が返る。
        let result = reg.poll(&session);
        assert_eq!(result, Some((true, Some(tok))));
    }

    /// 存在しないコードを承認しようとしても false になる。
    #[test]
    fn test_wrong_code_no_approval() {
        let reg = PairingRegistry::default();
        let (_session, _code) = reg.create_session();

        let ok = reg.approve_by_code("ZZZZZZ", "token".to_string());
        assert!(!ok);
    }

    /// 大文字小文字・前後空白は正規化されて一致する。
    #[test]
    fn test_code_case_insensitive_trim() {
        let reg = PairingRegistry::default();
        let (_session, code) = reg.create_session();
        let lower = format!(" {} ", code.to_lowercase());
        let ok = reg.approve_by_code(&lower, "tok".to_string());
        assert!(ok);
    }

    /// 不明な session ID は poll が None を返す。
    #[test]
    fn test_unknown_session_returns_none() {
        let reg = PairingRegistry::default();
        assert!(reg.poll("nonexistent-session").is_none());
    }

    /// 承認済みのコードを二重承認しようとしても false になる。
    #[test]
    fn test_double_approve_returns_false() {
        let reg = PairingRegistry::default();
        let (_session, code) = reg.create_session();

        let ok1 = reg.approve_by_code(&code, "tok1".to_string());
        assert!(ok1);
        let ok2 = reg.approve_by_code(&code, "tok2".to_string());
        assert!(!ok2);
    }

    /// pending_list は未承認セッションのみ返す。
    #[test]
    fn test_pending_list() {
        let reg = PairingRegistry::default();
        let (_s1, _c1) = reg.create_session();
        let (_s2, c2) = reg.create_session();

        // c2 を承認。
        reg.approve_by_code(&c2, "tok".to_string());

        let pending = reg.pending_list();
        // 2 セッション中 1 つが承認済みなので 1 件のみ。
        assert_eq!(pending.len(), 1);
    }

    /// gen_code は SAFE_CHARS のみから構成される。
    #[test]
    fn test_gen_code_uses_safe_chars() {
        for _ in 0..100 {
            let code = gen_code();
            assert_eq!(code.len(), 6);
            for ch in code.chars() {
                assert!(
                    SAFE_CHARS.contains(&(ch as u8)),
                    "unexpected char: {ch}"
                );
            }
        }
    }
}
