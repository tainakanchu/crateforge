use tauri::AppHandle;

use crate::cd_ripper;
use crate::commands::library::open_db;
use crate::metadata::{disc_id::calculate_musicbrainz_id, musicbrainz};
use crate::models::{DiscToc, ReleaseCandidate, RipRequest};

#[tauri::command]
pub fn detect_disc(device: Option<String>) -> Result<DiscToc, String> {
    let dev = device.unwrap_or_else(default_device);
    cd_ripper::detect_disc(&dev)
}

#[tauri::command]
pub async fn lookup_release_by_disc_id(
    musicbrainz_id: String,
) -> Result<Vec<ReleaseCandidate>, String> {
    musicbrainz::lookup_by_disc_id(&musicbrainz_id).await
}

#[tauri::command]
pub async fn lookup_release_by_toc(
    track_count: usize,
    leadout: u32,
    offsets: Vec<u32>,
) -> Result<Vec<ReleaseCandidate>, String> {
    musicbrainz::lookup_by_toc(track_count, leadout, &offsets).await
}

/// disc_id を再計算するヘルパー (UI 側で TOC を編集後に使う想定)。
#[tauri::command]
pub fn compute_disc_id(first_track: u8, last_track: u8, leadout: u32, offsets: Vec<u32>) -> String {
    calculate_musicbrainz_id(first_track, last_track, leadout, &offsets)
}

#[tauri::command]
pub async fn rip_cd(app: AppHandle, request: RipRequest) -> Result<(), String> {
    // Windows は flac/lame CLI が無いので、エンコード用に ffmpeg を先に用意する
    // （未取得なら自動 DL）。Unix は None のまま flac/lame を PATH から使う。
    #[cfg(target_os = "windows")]
    let ffmpeg = Some(
        crate::ffmpeg::ensure(&app)
            .await
            .map_err(|e| format!("ffmpeg を準備できませんでした: {}", e))?,
    );
    #[cfg(not(target_os = "windows"))]
    let ffmpeg: Option<std::path::PathBuf> = None;

    // CD reading + encoding are blocking. Run in a worker so async commands stay responsive.
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = open_db(&app2)?;
        cd_ripper::rip_cd(&app2, &db, request, ffmpeg)
    })
    .await
    .map_err(|e| format!("rip task panicked: {}", e))?
}

fn default_device() -> String {
    #[cfg(target_os = "linux")]
    {
        "/dev/cdrom".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "disk1".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "D:".to_string()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        String::new()
    }
}
