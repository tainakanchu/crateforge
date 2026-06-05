//! System Media Transport Controls (Windows 10/11 の "Now Playing" 連携)。
//!
//! - 起動時にメインウィンドウの HWND を取得して `souvlaki::MediaControls` を初期化
//! - メディアキー (Play/Pause/Next/Prev) 押下を Tauri Event `smtc-button` として
//!   フロントに emit
//! - フロントの再生 polling から `update_smtc` コマンドが呼ばれてメタデータ・
//!   再生状態を SMTC に反映
//!
//! Windows 以外の OS では何もしない。

#[cfg(target_os = "windows")]
mod inner {
    use std::sync::Mutex;

    use souvlaki::{
        MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
        PlatformConfig,
    };
    use tauri::{AppHandle, Emitter, Manager};

    pub struct SmtcState {
        controls: Option<MediaControls>,
    }

    // souvlaki::MediaControls holds COM pointers on Windows; we serialize access via
    // a Mutex and never share the pointer across threads outside the lock.
    unsafe impl Send for SmtcState {}
    unsafe impl Sync for SmtcState {}

    impl SmtcState {
        pub fn new() -> Self {
            SmtcState { controls: None }
        }
    }

    pub fn init(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or("main window not found")?;
        let hwnd = window
            .hwnd()
            .map_err(|e| format!("hwnd: {}", e))?
            .0 as *mut std::ffi::c_void;

        let config = PlatformConfig {
            dbus_name: "com.tainakanchu.crateforge",
            display_name: "Crateforge",
            hwnd: Some(hwnd),
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
}

#[cfg(not(target_os = "windows"))]
mod inner {
    use tauri::AppHandle;

    pub struct SmtcState;

    impl SmtcState {
        pub fn new() -> Self {
            SmtcState
        }
    }

    pub fn init(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub fn update(
        _state: &mut SmtcState,
        _title: &str,
        _artist: &str,
        _album: &str,
        _is_playing: bool,
        _position_ms: u64,
        _duration_ms: u64,
    ) -> Result<(), String> {
        Ok(())
    }
}

pub use inner::{init, SmtcState};
// `update` is only called via the commands::smtc bridge.
#[allow(unused_imports)]
pub use inner::update;
