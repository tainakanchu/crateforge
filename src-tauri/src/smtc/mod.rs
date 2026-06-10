//! OS メディアコントロール連携。
//!
//! - **Windows**: System Media Transport Controls (SMTC) — Now Playing ウィジェット・
//!   メディアキー対応
//! - **Linux**: MPRIS (Media Player Remote Interfacing Specification) — D-Bus 経由で
//!   playerctld / KDE Connect 等と連携
//! - **macOS**: Now Playing Center (CommandCenter) — Control Center の再生情報・
//!   メディアキー対応
//!
//! 起動時にメインウィンドウを取得して `souvlaki::MediaControls` を初期化し、
//! メディアキー押下を Tauri Event `smtc-button` としてフロントに emit する。
//! フロントの再生 polling から `update_smtc` コマンドが呼ばれてメタデータ・
//! 再生状態を OS 側に反映する。
//! 初期化失敗はノンブロッキング (best-effort)。

use std::sync::Mutex;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager};

pub struct SmtcState {
    controls: Option<MediaControls>,
}

// souvlaki::MediaControls は内部に COM ポインタ (Windows) / D-Bus 接続 (Linux) /
// dispatch キュー参照 (macOS) を持つ。Mutex による直列アクセスで安全に扱う。
unsafe impl Send for SmtcState {}
unsafe impl Sync for SmtcState {}

impl SmtcState {
    pub fn new() -> Self {
        SmtcState { controls: None }
    }
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    // Windows のみ HWND が必要。
    #[cfg(target_os = "windows")]
    let hwnd = {
        let window = app
            .get_webview_window("main")
            .ok_or("main window not found")?;
        let raw = window.hwnd().map_err(|e| format!("hwnd: {}", e))?.0
            as *mut std::ffi::c_void;
        Some(raw)
    };
    #[cfg(not(target_os = "windows"))]
    let hwnd = None;

    let config = PlatformConfig {
        dbus_name: "com.tainakanchu.crateforge",
        display_name: "Crateforge",
        hwnd,
    };

    let mut controls = MediaControls::new(config).map_err(|e| format!("{:?}", e))?;

    let app_handle = app.clone();
    controls
        .attach(move |event: MediaControlEvent| {
            let kind = match event {
                MediaControlEvent::Play => "play",
                MediaControlEvent::Pause => "pause",
                MediaControlEvent::Toggle => "toggle",
                MediaControlEvent::Next => "next",
                MediaControlEvent::Previous => "prev",
                MediaControlEvent::Stop => "stop",
                _ => return,
            };
            let _ = app_handle.emit("smtc-button", kind.to_string());
        })
        .map_err(|e| format!("{:?}", e))?;

    let state = app.state::<Mutex<SmtcState>>();
    state.lock().unwrap().controls = Some(controls);
    Ok(())
}

pub fn update(
    state: &mut SmtcState,
    title: &str,
    artist: &str,
    album: &str,
    is_playing: bool,
    position_ms: u64,
    duration_ms: u64,
) -> Result<(), String> {
    let Some(controls) = state.controls.as_mut() else {
        return Ok(());
    };

    controls
        .set_metadata(MediaMetadata {
            title: Some(title),
            artist: Some(artist),
            album: Some(album),
            duration: if duration_ms > 0 {
                Some(std::time::Duration::from_millis(duration_ms))
            } else {
                None
            },
            ..Default::default()
        })
        .map_err(|e| format!("{:?}", e))?;

    let progress = if duration_ms > 0 {
        Some(MediaPosition(std::time::Duration::from_millis(position_ms)))
    } else {
        None
    };

    if is_playing {
        controls
            .set_playback(MediaPlayback::Playing { progress })
            .map_err(|e| format!("{:?}", e))?;
    } else if position_ms > 0 {
        controls
            .set_playback(MediaPlayback::Paused { progress })
            .map_err(|e| format!("{:?}", e))?;
    } else {
        controls
            .set_playback(MediaPlayback::Stopped)
            .map_err(|e| format!("{:?}", e))?;
    }

    Ok(())
}
