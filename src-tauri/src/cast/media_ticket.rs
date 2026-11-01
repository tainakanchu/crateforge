//! Cast Receiver に渡す音源 URL 用の Media Ticket。
//!
//! LAN の API トークン (全権限) を Receiver に渡さないため、「特定の 1 曲を GET/HEAD で
//! 読むことだけ」を許す推測不能な短命トークンを発行する。
//!
//! - トークンは 32 byte 乱数の hex (64 文字)。曲 ID・Cast セッション ID に束縛する。
//! - Range や再接続で何度も取りに来るので、1 回のアクセスでは消費しない。
//! - 期限 = 発行 (延長) 時刻 + 曲長 + 30 分 (曲長不明なら 2 時間)。再生中は延長できる。
//! - 曲切替・切断・アプリ終了で失効 (`revoke*`)。期限切れは発行時に掃除する。
//! - トークン文字列はログに出さない。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 曲長に足す余裕。
const GRACE: Duration = Duration::from_secs(30 * 60);
/// 曲長不明時の期限。
const UNKNOWN_DURATION_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const TOKEN_HEX_LEN: usize = 64;

#[derive(Debug, Clone)]
struct Ticket {
    track_id: i64,
    session_id: u64,
    expires_at: Instant,
}

/// 発行済みチケットのレジストリ。axum ハンドラと Cast Coordinator で `Arc` を共有する。
#[derive(Clone, Default)]
pub struct MediaTickets {
    inner: Arc<Mutex<HashMap<String, Ticket>>>,
}

fn ttl(duration_ms: u64) -> Duration {
    if duration_ms == 0 {
        UNKNOWN_DURATION_TTL
    } else {
        Duration::from_millis(duration_ms) + GRACE
    }
}

fn gen_token() -> String {
    let mut bytes = [0u8; 32];
    // 乱数源が使えない環境では発行自体を諦める (推測可能なトークンは作らない)。
    getrandom::getrandom(&mut bytes).expect("OS random source unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// トークンの形式 (64 文字の小文字 hex) か。ルックアップ前の安価な門前払いに使う。
pub fn is_token_shaped(token: &str) -> bool {
    token.len() == TOKEN_HEX_LEN
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl MediaTickets {
    /// `track_id` 用のチケットを発行する。`session_id` は Cast セッションの識別子
    /// (切断時に `revoke_session` でまとめて失効させる)。
    pub fn issue(&self, track_id: i64, session_id: u64, duration_ms: u64) -> String {
        self.issue_at(track_id, session_id, duration_ms, Instant::now())
    }

    /// 発行時刻を指定して発行する (テストで期限切れを作るため)。
    pub(crate) fn issue_at(
        &self,
        track_id: i64,
        session_id: u64,
        duration_ms: u64,
        now: Instant,
    ) -> String {
        let token = gen_token();
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, t| t.expires_at > now);
        map.insert(
            token.clone(),
            Ticket {
                track_id,
                session_id,
                expires_at: now + ttl(duration_ms),
            },
        );
        token
    }

    /// 有効なら束縛された track_id を返す。未知・期限切れ・失効はすべて None
    /// (呼び出し側で区別させない)。
    pub fn validate(&self, token: &str) -> Option<i64> {
        self.validate_at(token, Instant::now())
    }

    fn validate_at(&self, token: &str, now: Instant) -> Option<i64> {
        if !is_token_shaped(token) {
            return None;
        }
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.get(token)
            .filter(|t| t.expires_at > now)
            .map(|t| t.track_id)
    }

    /// 再生継続中の延長。期限を「今 + 曲長 + 余裕」まで伸ばす (縮めはしない)。
    pub fn extend(&self, token: &str, duration_ms: u64) {
        self.extend_at(token, duration_ms, Instant::now());
    }

    fn extend_at(&self, token: &str, duration_ms: u64, now: Instant) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = map.get_mut(token) {
            if t.expires_at > now {
                t.expires_at = t.expires_at.max(now + ttl(duration_ms));
            }
        }
    }

    pub fn revoke(&self, token: &str) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(token);
    }

    /// あるセッションのチケットをすべて失効させる (切断時)。
    pub fn revoke_session(&self, session_id: u64) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, t| t.session_id != session_id);
    }

    /// 全チケットを失効させる (アプリ終了 / API サーバー停止時)。
    pub fn revoke_all(&self) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issued_token_is_opaque_and_bound_to_track() {
        let t = MediaTickets::default();
        let a = t.issue(1, 10, 180_000);
        let b = t.issue(2, 10, 180_000);
        assert!(is_token_shaped(&a));
        assert_ne!(a, b);
        assert_eq!(t.validate(&a), Some(1));
        assert_eq!(t.validate(&b), Some(2));
        // 何度読んでも消費されない (Range / 再接続)。
        assert_eq!(t.validate(&a), Some(1));
    }

    #[test]
    fn rejects_unknown_and_malformed() {
        let t = MediaTickets::default();
        t.issue(1, 1, 0);
        assert_eq!(t.validate(&"0".repeat(64)), None);
        assert_eq!(t.validate("short"), None);
        assert_eq!(t.validate(&"G".repeat(64)), None);
        assert_eq!(t.validate(""), None);
    }

    #[test]
    fn expires_after_duration_plus_grace() {
        let t = MediaTickets::default();
        let now = Instant::now();
        let tok = t.issue_at(1, 1, 60_000, now);
        let deadline = now + Duration::from_secs(60) + GRACE;
        assert_eq!(
            t.validate_at(&tok, deadline - Duration::from_secs(1)),
            Some(1)
        );
        assert_eq!(t.validate_at(&tok, deadline), None);

        let unknown = t.issue_at(2, 1, 0, now);
        assert_eq!(
            t.validate_at(
                &unknown,
                now + UNKNOWN_DURATION_TTL - Duration::from_secs(1)
            ),
            Some(2)
        );
        assert_eq!(t.validate_at(&unknown, now + UNKNOWN_DURATION_TTL), None);
    }

    #[test]
    fn extend_moves_deadline_forward_only_while_valid() {
        let t = MediaTickets::default();
        let now = Instant::now();
        let tok = t.issue_at(1, 1, 60_000, now);
        let later = now + Duration::from_secs(20 * 60);
        t.extend_at(&tok, 60_000, later);
        let new_deadline = later + Duration::from_secs(60) + GRACE;
        assert_eq!(
            t.validate_at(&tok, new_deadline - Duration::from_secs(1)),
            Some(1)
        );
        assert_eq!(t.validate_at(&tok, new_deadline), None);

        // 期限切れ後の延長では復活しない。
        let dead = t.issue_at(2, 1, 1_000, now);
        let after = now + Duration::from_secs(3600);
        t.extend_at(&dead, 1_000, after);
        assert_eq!(t.validate_at(&dead, after), None);
    }

    #[test]
    fn revoke_and_revoke_session() {
        let t = MediaTickets::default();
        let a = t.issue(1, 7, 0);
        let b = t.issue(2, 7, 0);
        let c = t.issue(3, 8, 0);
        t.revoke(&a);
        assert_eq!(t.validate(&a), None);
        assert_eq!(t.validate(&b), Some(2));
        t.revoke_session(7);
        assert_eq!(t.validate(&b), None);
        assert_eq!(t.validate(&c), Some(3));
        t.revoke_all();
        assert_eq!(t.validate(&c), None);
    }

    #[test]
    fn issue_prunes_expired() {
        let t = MediaTickets::default();
        let now = Instant::now();
        t.issue_at(1, 1, 1_000, now);
        t.issue_at(2, 1, 0, now + GRACE + Duration::from_secs(5));
        assert_eq!(t.len(), 1);
    }
}
