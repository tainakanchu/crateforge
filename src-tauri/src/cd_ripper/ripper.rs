use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::Command;

use tauri::{AppHandle, Emitter};

use crate::cd_ripper::encoder::{self, EncodeMeta};
use crate::db::Database;
use crate::itunes_xml::writer::path_to_file_url;
use crate::models::{EncodeFormat, RipProgress, RipRequest};

/// CD を取り込む。
///
/// `ffmpeg` は Windows でのみ Some（自動 DL 済みパス）。FLAC/MP3/ALAC のエンコードに使う。
/// Unix では None で、従来どおり cdparanoia + flac/lame を使う。
pub fn rip_cd(
    app: &AppHandle,
    db: &Database,
    req: RipRequest,
    ffmpeg: Option<PathBuf>,
) -> Result<(), String> {
    let output_dir = Path::new(&req.output_dir);
    std::fs::create_dir_all(output_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    // Windows はドライブを 1 回開いて TOC を読み、以降ループ内で CDDA を直接読む。
    #[cfg(windows)]
    let (drive, win_toc) = {
        let d = crate::cd_ripper::win_cd::open_drive(&req.device)?;
        let t = d.read_toc()?;
        (d, t)
    };

    let mut written_files: Vec<String> = Vec::new();
    let mut added_tracks = 0usize;

    let tracks_to_rip = if req.tracks.is_empty() {
        if let Some(ref rel) = req.release {
            (1..=rel.track_count).collect()
        } else {
            return Err("No tracks specified and no release metadata available".to_string());
        }
    } else {
        req.tracks.clone()
    };

    let total = tracks_to_rip.len();
    let _ = app.emit("rip-progress", RipProgress::Start { total });

    for (idx, &track_num) in tracks_to_rip.iter().enumerate() {
        let label = req
            .release
            .as_ref()
            .and_then(|r| r.tracks.iter().find(|t| t.position == track_num))
            .map(|t| format!("{} - {}", t.artist, t.title))
            .unwrap_or_else(|| format!("Track {:02}", track_num));

        let _ = app.emit(
            "rip-progress",
            RipProgress::TrackStart {
                index: idx,
                total,
                label: label.clone(),
            },
        );

        // 1. Rip to a temporary WAV.
        let wav_path = output_dir.join(format!(".tmp_track_{:02}.wav", track_num));

        // Unix: cdparanoia 経由で WAV を取得。
        #[cfg(not(windows))]
        {
            let mut cdp_cmd = Command::new("cdparanoia");
            cdp_cmd
                .arg("-d")
                .arg(&req.device)
                .arg("-w")
                .arg(format!("{}", track_num))
                .arg(&wav_path);
            // Windows でコンソール窓を出さない (課題1)。この経路は non-Windows のみだが
            // 共通ヘルパに揃えておく (no-op)。
            crate::proc::no_window(&mut cdp_cmd);
            let cdp_status = cdp_cmd.status().map_err(|e| {
                format!(
                    "`cdparanoia` not found ({}). Use `nix develop` so the toolchain is in PATH.",
                    e
                )
            })?;
            if !cdp_status.success() {
                return Err(format!(
                    "cdparanoia failed for track {} (device {})",
                    track_num, req.device
                ));
            }
        }

        // Windows: IOCTL で CDDA 生データを読んで WAV を書き出す。
        #[cfg(windows)]
        {
            let pcm = drive.read_track_pcm(&win_toc, track_num)?;
            crate::cd_ripper::win_cd::write_wav(&wav_path, &pcm)?;
        }

        // 2. Determine final output path + metadata.
        let release_track = req
            .release
            .as_ref()
            .and_then(|r| r.tracks.iter().find(|t| t.position == track_num));
        let title = release_track.map(|t| t.title.as_str());
        let track_artist = release_track.map(|t| t.artist.as_str());
        let album_artist = req.release.as_ref().map(|r| r.artist.as_str());
        let album = req.release.as_ref().map(|r| r.title.as_str());
        let date = req.release.as_ref().and_then(|r| r.date.as_deref());
        let track_count_meta = req.release.as_ref().map(|r| r.track_count as u32);

        let file_stem = match (release_track, req.release.as_ref()) {
            (Some(t), _) => format!("{:02} - {}", track_num, sanitize_filename(&t.title)),
            (None, _) => format!("Track {:02}", track_num),
        };
        let out_path = output_dir.join(format!("{}.{}", file_stem, req.format.extension()));

        // 3. Encode (or copy WAV).
        encoder::encode(
            req.format,
            &wav_path,
            &out_path,
            &EncodeMeta {
                title,
                artist: track_artist,
                album,
                album_artist,
                track_number: Some(track_num as u32),
                track_count: track_count_meta,
                date,
            },
            ffmpeg.as_deref(),
        )?;

        if req.format != EncodeFormat::Wav {
            std::fs::remove_file(&wav_path).ok();
        }

        let out_path_str = out_path.to_string_lossy().to_string();
        written_files.push(out_path_str.clone());

        // 4. Optionally add to library DB.
        if req.add_to_library {
            let location_url = path_to_file_url(&out_path_str);
            let length_ms = release_track.and_then(|t| t.length_ms).map(|x| x as i64);
            let year = date
                .and_then(|d| d.split('-').next())
                .and_then(|y| y.parse::<i64>().ok());

            db.add_imported_track(
                title,
                track_artist,
                album_artist,
                album,
                None,
                year,
                Some(track_num as i64),
                req.release.as_ref().map(|r| r.track_count as i64),
                Some(1),
                Some(1),
                length_ms,
                &out_path_str,
                &location_url,
            )
            .map_err(|e| format!("DB insert failed: {}", e))?;
            added_tracks += 1;
        }

        let _ = app.emit(
            "rip-progress",
            RipProgress::TrackDone {
                index: idx,
                output_path: out_path_str,
            },
        );
    }

    let _ = app.emit(
        "rip-progress",
        RipProgress::Done {
            written_files,
            added_tracks,
        },
    );
    Ok(())
}

pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>()
        .trim()
        .to_string()
}
