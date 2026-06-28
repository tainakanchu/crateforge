//! LAN 公開中の内蔵 API サーバーを mDNS (DNS-SD) で広告する。
//!
//! クライアント (モバイル等) が `_crateforge._tcp.local.` を探索して
//! ホスト・ポートを自動発見できるようにするためのサーバー側アドバタイズ。
//! クライアント側の探索 (zeroconf 等) は別 issue の範囲なので、ここでは
//! 「広告する」ことだけを担う。
//!
//! 広告はベストエフォート。`ServiceDaemon` の生成や `register` が失敗しても
//! サーバー本体の稼働には影響させない (呼び出し側が `Err` を warn ログに留める)。
//! IP アドレスは `enable_addr_auto` で OS から自動検出・追従させるため、
//! 手動でのインタフェース列挙は不要。

use mdns_sd::{ServiceDaemon, ServiceInfo};

/// mDNS サービス種別。
const SERVICE_TYPE: &str = "_crateforge._tcp.local.";
/// インスタンス名が取得できなかった場合のフォールバック。
const FALLBACK_INSTANCE_NAME: &str = "Crateforge";

/// OS のホスト名を取得し、mDNS インスタンス名として安全な文字列を返す。
///
/// mDNS の DNS-SD インスタンス名には UTF-8 が使えるが、空文字や極端に長い名前は
/// 避けたほうが実装間の互換性が高い。ここでは ASCII 英数字とハイフン以外の文字を
/// ハイフンに置換し、先頭・末尾のハイフンを除去した上で、最大 63 文字に切り詰める。
/// 結果が空になった場合はフォールバック名を返す。
fn instance_name() -> String {
    let raw = gethostname::gethostname()
        .into_string()
        .unwrap_or_default();

    // ASCII 英数字・ハイフン以外はハイフンに変換し、連続ハイフンを1つに畳む。
    let sanitized: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    // 先頭・末尾のハイフンは既に除去済み。最大 63 文字に切り詰め。
    let truncated: String = sanitized.chars().take(63).collect();

    if truncated.is_empty() {
        FALLBACK_INSTANCE_NAME.to_string()
    } else {
        truncated
    }
}

/// 稼働中の mDNS 広告。`Drop` で unregister + shutdown する
/// (= サーバー停止に追従してネットワークから広告を取り下げる)。
pub struct MdnsAdvertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MdnsAdvertiser {
    /// 指定ポートで API サーバーを広告し始める。
    /// インスタンス名は OS のホスト名（取得失敗時は "Crateforge"）。
    /// IP アドレスは `enable_addr_auto` で自動検出するため、空文字を渡す。
    pub fn start(port: u16) -> Result<Self, String> {
        let name = instance_name();
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let host_name = format!("{}.local.", name.to_lowercase());
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &name,
            &host_name,
            "", // ip: enable_addr_auto で自動補完するためプレースホルダ
            port,
            &[("path", "/")][..],
        )
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
        let fullname = service.get_fullname().to_string();
        daemon.register(service).map_err(|e| e.to_string())?;
        Ok(MdnsAdvertiser { daemon, fullname })
    }
}

impl Drop for MdnsAdvertiser {
    fn drop(&mut self) {
        // どちらもベストエフォート (受信側 Receiver は捨てる)。
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_name_not_empty() {
        let name = instance_name();
        assert!(!name.is_empty(), "instance_name() must never return empty string");
    }

    #[test]
    fn instance_name_no_invalid_chars() {
        let name = instance_name();
        for c in name.chars() {
            assert!(
                c.is_ascii_alphanumeric() || c == '-',
                "unexpected char '{}' in instance_name '{}'",
                c,
                name
            );
        }
    }

    #[test]
    fn instance_name_length_limit() {
        let name = instance_name();
        assert!(name.len() <= 63, "instance_name too long: {}", name.len());
    }
}
