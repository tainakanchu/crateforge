//! Google Cast (CastV2) Sender。同一 LAN の Cast 端末 (Chromecast / Google TV 等) を
//! 再生先にするための部品群。設計は `docs/cast/design.md` を参照。
//!
//! - [`discovery`]    : `_googlecast._tcp.local.` の mDNS 探索と端末一覧。
//! - [`proto`]        : `CastMessage` (protobuf) の手書き encode/decode と長さプレフィクス framing。
//! - [`transport`]    : TLS 接続 (`CastTransport`)。テストではモックに差し替える。
//! - [`protocol`]     : namespace ごとの JSON メッセージ builder / parser。
//! - [`session`]      : 1 端末との接続を駆動する `CastSession` (Default Media Receiver)。
//! - [`media_ticket`] : Receiver に渡す音源 URL 用の短命チケット。
//!
//! 再生先の切替・キュー連携 (Coordinator) はこのモジュールの外 (`playback_target`) が担う。

pub mod discovery;
pub mod media_ticket;
pub mod proto;
pub mod protocol;
pub mod session;
pub mod transport;

use std::net::{IpAddr, SocketAddr};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// 再生先。同時に 1 つだけ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlaybackTarget {
    Local,
    GoogleCast {
        device_id: String,
        device_name: String,
    },
}

/// Cast 接続の状態 (UI 表示用)。再生先が Local のときは `Idle`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CastConnectionState {
    Idle,
    Discovering,
    Connecting,
    Connected,
    Buffering,
    Reconnecting,
    Disconnected,
    Error,
}

/// フロントが原因と対処を出し分けるためのエラーコード。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CastErrorCode {
    LanDisabled,
    DeviceNotFound,
    ConnectFailed,
    LaunchFailed,
    UnsupportedFormat,
    TrackUnavailable,
    LoadFailed,
    PreviewActive,
    ConnectionLost,
    Superseded,
    Internal,
}

impl CastErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CastErrorCode::LanDisabled => "LAN_DISABLED",
            CastErrorCode::DeviceNotFound => "DEVICE_NOT_FOUND",
            CastErrorCode::ConnectFailed => "CONNECT_FAILED",
            CastErrorCode::LaunchFailed => "LAUNCH_FAILED",
            CastErrorCode::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            CastErrorCode::TrackUnavailable => "TRACK_UNAVAILABLE",
            CastErrorCode::LoadFailed => "LOAD_FAILED",
            CastErrorCode::PreviewActive => "PREVIEW_ACTIVE",
            CastErrorCode::ConnectionLost => "CONNECTION_LOST",
            CastErrorCode::Superseded => "SUPERSEDED",
            CastErrorCode::Internal => "INTERNAL",
        }
    }
}

/// Cast 操作のエラー。Tauri コマンドへは `"<CODE>: <message>"` 文字列で返す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CastError {
    pub code: CastErrorCode,
    pub message: String,
}

impl CastError {
    pub fn new(code: CastErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CastError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for CastError {}

impl From<CastError> for String {
    fn from(e: CastError) -> Self {
        e.to_string()
    }
}

/// 探索で見つかった Cast 端末。`id` は TXT `id` (端末固有で IP が変わっても不変)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    pub model: Option<String>,
    /// IP アドレス文字列。
    pub host: String,
    pub port: u16,
}

impl CastDevice {
    pub fn socket_addr(&self) -> Option<SocketAddr> {
        let ip: IpAddr = self.host.parse().ok()?;
        Some(SocketAddr::new(ip, self.port))
    }
}

/// UI / Remote API が参照する Cast の状態。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastStatus {
    pub target: PlaybackTarget,
    pub connection_state: CastConnectionState,
    pub is_playing: bool,
    pub current_track_id: Option<i64>,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub volume: f32,
    pub last_error: Option<CastError>,
    /// 最後に Receiver から状態を受け取った時刻 (epoch ms)。
    pub last_status_at: Option<u64>,
}

impl Default for CastStatus {
    fn default() -> Self {
        Self {
            target: PlaybackTarget::Local,
            connection_state: CastConnectionState::Idle,
            is_playing: false,
            current_track_id: None,
            position_ms: 0,
            duration_ms: 0,
            volume: 1.0,
            last_error: None,
            last_status_at: None,
        }
    }
}

/// Cast 端末から見て到達可能な、このマシンのローカル IP を返す。
///
/// 端末宛に UDP ソケットを `connect` するとルーティング表に従って送信元アドレスが
/// 決まる (実際のパケットは送らない)。複数 NIC / VPN でも端末と同じ経路の IP を選べる。
/// ループバック・未指定アドレスは Receiver から到達できないので拒否する。
pub fn local_ip_for(device: SocketAddr) -> Result<IpAddr, CastError> {
    let bind: SocketAddr = if device.is_ipv4() {
        "0.0.0.0:0".parse().unwrap()
    } else {
        "[::]:0".parse().unwrap()
    };
    let sock = std::net::UdpSocket::bind(bind)
        .map_err(|e| CastError::new(CastErrorCode::ConnectFailed, format!("udp bind: {e}")))?;
    sock.connect(device)
        .map_err(|e| CastError::new(CastErrorCode::ConnectFailed, format!("no route: {e}")))?;
    let ip = sock
        .local_addr()
        .map_err(|e| CastError::new(CastErrorCode::ConnectFailed, e.to_string()))?
        .ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return Err(CastError::new(
            CastErrorCode::ConnectFailed,
            "Cast 端末へ到達できるネットワークアドレスが見つかりません",
        ));
    }
    Ok(ip)
}

/// P0 で Cast に渡す音源形式の許可リスト。ファイルを見て Content-Type を決める。
///
/// - MP3 → `audio/mpeg`
/// - MP4 コンテナ (m4a/mp4/m4b/aac) で実コーデックが AAC → `audio/mp4`
///   (拡張子だけで ALAC を AAC 扱いしないよう、lofty で中身を確認する)
/// - それ以外 (FLAC / WAV / AIFF / ALAC / Opus / Ogg ...) は `UNSUPPORTED_FORMAT`。
///   既存の ADTS 逐次トランスコードは Cast でのシークが保証できないため使わない。
pub fn cast_media_type(path: &Path) -> Result<&'static str, CastError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let unsupported = |label: &str| {
        CastError::new(
            CastErrorCode::UnsupportedFormat,
            format!("{label} は Cast 再生に未対応の形式です (対応: MP3 / AAC(M4A))"),
        )
    };
    match ext.as_str() {
        "mp3" => Ok("audio/mpeg"),
        "m4a" | "mp4" | "m4b" | "aac" => {
            use lofty::file::AudioFile;
            let file = std::fs::File::open(path).map_err(|_| {
                CastError::new(CastErrorCode::TrackUnavailable, "音源ファイルを開けません")
            })?;
            let mut reader = std::io::BufReader::new(file);
            let opts = lofty::config::ParseOptions::new()
                .read_tags(false)
                .read_cover_art(false);
            match lofty::mp4::Mp4File::read_from(&mut reader, opts) {
                Ok(f) if *f.properties().codec() == lofty::mp4::Mp4Codec::AAC => Ok("audio/mp4"),
                Ok(f) => Err(unsupported(&format!("{:?}", f.properties().codec()))),
                // ADTS 生 AAC (.aac) など MP4 として読めないものは対象外。
                Err(_) => Err(unsupported(&ext.to_ascii_uppercase())),
            }
        }
        "" => Err(unsupported("拡張子なし")),
        other => Err(unsupported(&other.to_ascii_uppercase())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_target_serde_shape() {
        let local = serde_json::to_value(PlaybackTarget::Local).unwrap();
        assert_eq!(local, serde_json::json!({ "type": "local" }));
        let cast = serde_json::to_value(PlaybackTarget::GoogleCast {
            device_id: "abc".into(),
            device_name: "Living TV".into(),
        })
        .unwrap();
        assert_eq!(
            cast,
            serde_json::json!({ "type": "googleCast", "deviceId": "abc", "deviceName": "Living TV" })
        );
        let back: PlaybackTarget = serde_json::from_value(cast).unwrap();
        assert!(matches!(back, PlaybackTarget::GoogleCast { .. }));
    }

    #[test]
    fn error_codes_serialize_and_format() {
        let e = CastError::new(CastErrorCode::LanDisabled, "LAN 公開が無効です");
        assert_eq!(e.to_string(), "LAN_DISABLED: LAN 公開が無効です");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "LAN_DISABLED");
        assert_eq!(
            serde_json::to_value(CastConnectionState::Reconnecting).unwrap(),
            "reconnecting"
        );
        let status = serde_json::to_value(CastStatus::default()).unwrap();
        assert_eq!(status["connectionState"], "idle");
        assert_eq!(status["target"]["type"], "local");
        assert!(status["lastError"].is_null());
    }

    #[test]
    fn media_type_allowlist() {
        let dir = tempfile::tempdir().unwrap();
        let mp3 = dir.path().join("a.MP3");
        std::fs::write(&mp3, b"ID3").unwrap();
        assert_eq!(cast_media_type(&mp3).unwrap(), "audio/mpeg");

        for name in ["a.flac", "a.wav", "a.aiff", "a.opus", "a.ogg", "noext"] {
            let p = dir.path().join(name);
            std::fs::write(&p, b"x").unwrap();
            assert_eq!(
                cast_media_type(&p).unwrap_err().code,
                CastErrorCode::UnsupportedFormat,
                "{name}"
            );
        }
        // MP4 として読めない m4a (壊れている / ADTS) は拡張子だけで通さない。
        let bogus = dir.path().join("a.m4a");
        std::fs::write(&bogus, b"not an mp4").unwrap();
        assert_eq!(
            cast_media_type(&bogus).unwrap_err().code,
            CastErrorCode::UnsupportedFormat
        );
    }

    #[test]
    fn local_ip_for_rejects_loopback_route() {
        // ループバック宛は送信元もループバックになるので拒否される。
        let err = local_ip_for("127.0.0.1:8009".parse().unwrap()).unwrap_err();
        assert_eq!(err.code, CastErrorCode::ConnectFailed);
    }
}
