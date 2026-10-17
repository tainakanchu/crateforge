//! CastV2 の namespace と JSON メッセージ。
//!
//! 参考: <https://developers.google.com/cast/docs/media/messages>
//! 送信は builder 関数で [`CastMessage`] を作り、受信は [`parse`] で [`Incoming`] に分類する。
//! 時刻は Cast 側が秒 (浮動小数) なので、ここで ms と相互変換する。

use serde_json::{json, Value};

use super::proto::CastMessage;

pub const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
pub const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
pub const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
pub const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";

pub const SENDER_ID: &str = "sender-0";
pub const RECEIVER_ID: &str = "receiver-0";
/// Google の Default Media Web Receiver。
pub const DEFAULT_MEDIA_RECEIVER_APP_ID: &str = "CC1AD845";

fn msg(dest: &str, namespace: &str, payload: Value) -> CastMessage {
    CastMessage {
        source_id: SENDER_ID.into(),
        destination_id: dest.into(),
        namespace: namespace.into(),
        payload_utf8: payload.to_string(),
        payload_binary: None,
    }
}

fn ms_to_sec(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

fn sec_to_ms(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(|s| (s * 1000.0).round() as u64)
}

// ===== connection / heartbeat =====

pub fn connect(dest: &str) -> CastMessage {
    msg(
        dest,
        NS_CONNECTION,
        json!({ "type": "CONNECT", "origin": {}, "userAgent": "Crateforge" }),
    )
}

pub fn close(dest: &str) -> CastMessage {
    msg(dest, NS_CONNECTION, json!({ "type": "CLOSE" }))
}

pub fn ping() -> CastMessage {
    msg(RECEIVER_ID, NS_HEARTBEAT, json!({ "type": "PING" }))
}

pub fn pong(dest: &str) -> CastMessage {
    msg(dest, NS_HEARTBEAT, json!({ "type": "PONG" }))
}

// ===== receiver =====

pub fn get_status(request_id: u32) -> CastMessage {
    msg(
        RECEIVER_ID,
        NS_RECEIVER,
        json!({ "type": "GET_STATUS", "requestId": request_id }),
    )
}

pub fn launch(request_id: u32) -> CastMessage {
    msg(
        RECEIVER_ID,
        NS_RECEIVER,
        json!({ "type": "LAUNCH", "requestId": request_id, "appId": DEFAULT_MEDIA_RECEIVER_APP_ID }),
    )
}

/// Receiver アプリを終了する (TV 側の Cast 画面を閉じる)。
pub fn stop_app(request_id: u32, session_id: &str) -> CastMessage {
    msg(
        RECEIVER_ID,
        NS_RECEIVER,
        json!({ "type": "STOP", "requestId": request_id, "sessionId": session_id }),
    )
}

/// 端末音量 (0..1)。
pub fn set_volume(request_id: u32, level: f32) -> CastMessage {
    msg(
        RECEIVER_ID,
        NS_RECEIVER,
        json!({
            "type": "SET_VOLUME",
            "requestId": request_id,
            "volume": { "level": level.clamp(0.0, 1.0) },
        }),
    )
}

// ===== media =====

/// LOAD の中身。`content_id` は Receiver から到達できる音源 URL。
#[derive(Debug, Clone, PartialEq)]
pub struct LoadRequest {
    pub content_id: String,
    pub content_type: String,
    pub duration_ms: Option<u64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub start_ms: u64,
    pub autoplay: bool,
}

pub fn load(dest: &str, request_id: u32, req: &LoadRequest) -> CastMessage {
    // MusicTrackMediaMetadata (metadataType = 3)。値が無いキーは送らない。
    let mut metadata = json!({ "metadataType": 3 });
    for (key, val) in [
        ("title", &req.title),
        ("artist", &req.artist),
        ("albumName", &req.album),
    ] {
        if let Some(v) = val {
            metadata[key] = json!(v);
        }
    }
    let mut media = json!({
        "contentId": req.content_id,
        "contentType": req.content_type,
        "streamType": "BUFFERED",
        "metadata": metadata,
    });
    if let Some(d) = req.duration_ms.filter(|d| *d > 0) {
        media["duration"] = json!(ms_to_sec(d));
    }
    msg(
        dest,
        NS_MEDIA,
        json!({
            "type": "LOAD",
            "requestId": request_id,
            "media": media,
            "autoplay": req.autoplay,
            "currentTime": ms_to_sec(req.start_ms),
        }),
    )
}

fn media_cmd(dest: &str, kind: &str, request_id: u32, media_session_id: i64) -> CastMessage {
    msg(
        dest,
        NS_MEDIA,
        json!({ "type": kind, "requestId": request_id, "mediaSessionId": media_session_id }),
    )
}

pub fn media_get_status(dest: &str, request_id: u32) -> CastMessage {
    msg(
        dest,
        NS_MEDIA,
        json!({ "type": "GET_STATUS", "requestId": request_id }),
    )
}

pub fn play(dest: &str, request_id: u32, media_session_id: i64) -> CastMessage {
    media_cmd(dest, "PLAY", request_id, media_session_id)
}

pub fn pause(dest: &str, request_id: u32, media_session_id: i64) -> CastMessage {
    media_cmd(dest, "PAUSE", request_id, media_session_id)
}

pub fn media_stop(dest: &str, request_id: u32, media_session_id: i64) -> CastMessage {
    media_cmd(dest, "STOP", request_id, media_session_id)
}

pub fn seek(dest: &str, request_id: u32, media_session_id: i64, position_ms: u64) -> CastMessage {
    msg(
        dest,
        NS_MEDIA,
        json!({
            "type": "SEEK",
            "requestId": request_id,
            "mediaSessionId": media_session_id,
            "currentTime": ms_to_sec(position_ms),
        }),
    )
}

// ===== 受信 =====

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningApp {
    pub app_id: String,
    pub session_id: String,
    pub transport_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReceiverStatus {
    pub apps: Vec<RunningApp>,
    pub volume_level: Option<f32>,
    pub muted: Option<bool>,
}

impl ReceiverStatus {
    /// Default Media Receiver が動いていればそれを返す。
    pub fn media_app(&self) -> Option<&RunningApp> {
        self.apps
            .iter()
            .find(|a| a.app_id == DEFAULT_MEDIA_RECEIVER_APP_ID)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerState {
    Idle,
    Playing,
    Paused,
    Buffering,
    Loading,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleReason {
    Cancelled,
    Interrupted,
    Finished,
    Error,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaStatusEntry {
    pub media_session_id: i64,
    pub player_state: PlayerState,
    pub idle_reason: Option<IdleReason>,
    pub current_time_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub content_id: Option<String>,
    pub volume_level: Option<f32>,
}

/// 受信メッセージの分類。`request_id` は応答なら元の要求 ID、自発的な通知なら 0。
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Ping,
    Pong,
    /// 仮想接続の CLOSE (Receiver アプリ終了など)。
    Close,
    ReceiverStatus {
        request_id: u32,
        status: ReceiverStatus,
    },
    LaunchError {
        request_id: u32,
        reason: String,
    },
    MediaStatus {
        request_id: u32,
        entries: Vec<MediaStatusEntry>,
    },
    LoadFailed {
        request_id: u32,
    },
    LoadCancelled {
        request_id: u32,
    },
    InvalidRequest {
        request_id: u32,
        reason: String,
    },
    InvalidPlayerState {
        request_id: u32,
    },
    Other,
}

fn request_id(v: &Value) -> u32 {
    v.get("requestId").and_then(Value::as_u64).unwrap_or(0) as u32
}

fn parse_receiver_status(v: &Value) -> ReceiverStatus {
    let status = &v["status"];
    let apps = status["applications"]
        .as_array()
        .map(|apps| {
            apps.iter()
                .filter_map(|a| {
                    Some(RunningApp {
                        app_id: a["appId"].as_str()?.to_string(),
                        session_id: a["sessionId"].as_str()?.to_string(),
                        transport_id: a["transportId"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ReceiverStatus {
        apps,
        volume_level: status["volume"]["level"].as_f64().map(|l| l as f32),
        muted: status["volume"]["muted"].as_bool(),
    }
}

fn parse_media_entry(e: &Value) -> Option<MediaStatusEntry> {
    let player_state = match e["playerState"].as_str()? {
        "IDLE" => PlayerState::Idle,
        "PLAYING" => PlayerState::Playing,
        "PAUSED" => PlayerState::Paused,
        "BUFFERING" => PlayerState::Buffering,
        "LOADING" => PlayerState::Loading,
        _ => PlayerState::Unknown,
    };
    let idle_reason = e["idleReason"].as_str().map(|r| match r {
        "CANCELLED" => IdleReason::Cancelled,
        "INTERRUPTED" => IdleReason::Interrupted,
        "FINISHED" => IdleReason::Finished,
        "ERROR" => IdleReason::Error,
        _ => IdleReason::Other,
    });
    Some(MediaStatusEntry {
        media_session_id: e["mediaSessionId"].as_i64()?,
        player_state,
        idle_reason,
        current_time_ms: sec_to_ms(&e["currentTime"]),
        duration_ms: sec_to_ms(&e["media"]["duration"]),
        content_id: e["media"]["contentId"].as_str().map(str::to_string),
        volume_level: e["volume"]["level"].as_f64().map(|l| l as f32),
    })
}

/// 受信メッセージを分類する。壊れた JSON や未知の type は `Other`。
pub fn parse(m: &CastMessage) -> Incoming {
    let Ok(v) = serde_json::from_str::<Value>(&m.payload_utf8) else {
        return Incoming::Other;
    };
    let ty = v["type"].as_str().unwrap_or("");
    let rid = request_id(&v);
    let reason = || v["reason"].as_str().unwrap_or("").to_string();
    match (m.namespace.as_str(), ty) {
        (NS_HEARTBEAT, "PING") => Incoming::Ping,
        (NS_HEARTBEAT, "PONG") => Incoming::Pong,
        (NS_CONNECTION, "CLOSE") => Incoming::Close,
        (NS_RECEIVER, "RECEIVER_STATUS") => Incoming::ReceiverStatus {
            request_id: rid,
            status: parse_receiver_status(&v),
        },
        (NS_RECEIVER, "LAUNCH_ERROR") => Incoming::LaunchError {
            request_id: rid,
            reason: reason(),
        },
        (NS_RECEIVER, "INVALID_REQUEST") | (NS_MEDIA, "INVALID_REQUEST") => {
            Incoming::InvalidRequest {
                request_id: rid,
                reason: reason(),
            }
        }
        (NS_MEDIA, "MEDIA_STATUS") => Incoming::MediaStatus {
            request_id: rid,
            entries: v["status"]
                .as_array()
                .map(|a| a.iter().filter_map(parse_media_entry).collect())
                .unwrap_or_default(),
        },
        (NS_MEDIA, "LOAD_FAILED") => Incoming::LoadFailed { request_id: rid },
        (NS_MEDIA, "LOAD_CANCELLED") => Incoming::LoadCancelled { request_id: rid },
        (NS_MEDIA, "INVALID_PLAYER_STATE") => Incoming::InvalidPlayerState { request_id: rid },
        _ => Incoming::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn incoming(ns: &str, payload: &str) -> Incoming {
        parse(&CastMessage {
            source_id: "receiver-0".into(),
            destination_id: "sender-0".into(),
            namespace: ns.into(),
            payload_utf8: payload.into(),
            payload_binary: None,
        })
    }

    fn payload(m: &CastMessage) -> Value {
        serde_json::from_str(&m.payload_utf8).unwrap()
    }

    #[test]
    fn builds_load_with_music_metadata() {
        let m = load(
            "web-5",
            7,
            &LoadRequest {
                content_id: "http://192.168.1.2:8787/api/cast/media/abc".into(),
                content_type: "audio/mpeg".into(),
                duration_ms: Some(201_500),
                title: Some("Song".into()),
                artist: Some("Artist".into()),
                album: None,
                start_ms: 12_345,
                autoplay: false,
            },
        );
        assert_eq!(m.namespace, NS_MEDIA);
        assert_eq!(m.destination_id, "web-5");
        let p = payload(&m);
        assert_eq!(p["type"], "LOAD");
        assert_eq!(p["requestId"], 7);
        assert_eq!(p["autoplay"], false);
        assert_eq!(p["currentTime"], 12.345);
        assert_eq!(p["media"]["streamType"], "BUFFERED");
        assert_eq!(p["media"]["contentType"], "audio/mpeg");
        assert_eq!(p["media"]["duration"], 201.5);
        assert_eq!(p["media"]["metadata"]["metadataType"], 3);
        assert_eq!(p["media"]["metadata"]["title"], "Song");
        assert!(p["media"]["metadata"].get("albumName").is_none());
    }

    #[test]
    fn builds_control_messages() {
        assert_eq!(payload(&launch(1))["appId"], "CC1AD845");
        assert_eq!(payload(&seek("t", 3, 9, 1500))["currentTime"], 1.5);
        assert_eq!(payload(&pause("t", 4, 9))["mediaSessionId"], 9);
        assert_eq!(payload(&set_volume(5, 1.7))["volume"]["level"], 1.0);
        assert_eq!(payload(&stop_app(6, "s-1"))["sessionId"], "s-1");
        assert_eq!(ping().namespace, NS_HEARTBEAT);
        assert_eq!(payload(&connect("web-5"))["type"], "CONNECT");
    }

    #[test]
    fn parses_receiver_status() {
        let raw = r#"{"requestId":1,"status":{"applications":[{"appId":"CC1AD845",
            "displayName":"Default Media Receiver","namespaces":[{"name":"urn:x-cast:com.google.cast.media"}],
            "sessionId":"7E2FF513-CDF6-9A91-2B28-3E3DE7BAC174","statusText":"Ready To Cast",
            "transportId":"web-5"}],"isActiveInput":true,"volume":{"level":0.25,"muted":false}},
            "type":"RECEIVER_STATUS"}"#;
        let Incoming::ReceiverStatus { request_id, status } = incoming(NS_RECEIVER, raw) else {
            panic!("not receiver status");
        };
        assert_eq!(request_id, 1);
        let app = status.media_app().unwrap();
        assert_eq!(app.transport_id, "web-5");
        assert_eq!(app.session_id, "7E2FF513-CDF6-9A91-2B28-3E3DE7BAC174");
        assert_eq!(status.volume_level, Some(0.25));
        assert_eq!(status.muted, Some(false));
    }

    #[test]
    fn parses_media_status() {
        let raw = r#"{"type":"MEDIA_STATUS","status":[{"mediaSessionId":1,"playbackRate":1,
            "playerState":"PLAYING","currentTime":12.5,"supportedMediaCommands":15,
            "volume":{"level":1,"muted":false},"media":{"contentId":"http://x/a.mp3",
            "streamType":"BUFFERED","contentType":"audio/mpeg","duration":180.2}}],"requestId":0}"#;
        let Incoming::MediaStatus {
            request_id,
            entries,
        } = incoming(NS_MEDIA, raw)
        else {
            panic!("not media status");
        };
        assert_eq!(request_id, 0);
        let e = &entries[0];
        assert_eq!(e.media_session_id, 1);
        assert_eq!(e.player_state, PlayerState::Playing);
        assert_eq!(e.current_time_ms, Some(12_500));
        assert_eq!(e.duration_ms, Some(180_200));
        assert_eq!(e.content_id.as_deref(), Some("http://x/a.mp3"));

        let idle = r#"{"type":"MEDIA_STATUS","requestId":0,"status":[{"mediaSessionId":1,
            "playerState":"IDLE","idleReason":"FINISHED","currentTime":0}]}"#;
        let Incoming::MediaStatus { entries, .. } = incoming(NS_MEDIA, idle) else {
            panic!()
        };
        assert_eq!(entries[0].idle_reason, Some(IdleReason::Finished));
        assert_eq!(entries[0].content_id, None);
    }

    #[test]
    fn parses_errors_and_heartbeat() {
        assert_eq!(
            incoming(NS_MEDIA, r#"{"type":"LOAD_FAILED","requestId":9}"#),
            Incoming::LoadFailed { request_id: 9 }
        );
        assert_eq!(
            incoming(
                NS_RECEIVER,
                r#"{"type":"LAUNCH_ERROR","requestId":2,"reason":"NOT_FOUND"}"#
            ),
            Incoming::LaunchError {
                request_id: 2,
                reason: "NOT_FOUND".into()
            }
        );
        assert_eq!(
            incoming(
                NS_MEDIA,
                r#"{"type":"INVALID_REQUEST","requestId":3,"reason":"INVALID_MEDIA_SESSION_ID"}"#
            ),
            Incoming::InvalidRequest {
                request_id: 3,
                reason: "INVALID_MEDIA_SESSION_ID".into()
            }
        );
        assert_eq!(incoming(NS_HEARTBEAT, r#"{"type":"PING"}"#), Incoming::Ping);
        assert_eq!(
            incoming(NS_CONNECTION, r#"{"type":"CLOSE"}"#),
            Incoming::Close
        );
        assert_eq!(incoming(NS_MEDIA, "not json"), Incoming::Other);
    }
}
