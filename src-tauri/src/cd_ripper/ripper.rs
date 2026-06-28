use std::path::PathBuf;
#[cfg(not(windows))]
use std::process::Command;

use tauri::{AppHandle, Emitter};

use crate::cd_ripper::encoder::{self, EncodeMeta};
use crate::db::Database;
use crate::itunes_xml::writer::path_to_file_url;
use crate::models::{EncodeFormat, RipProgress, RipRequest};
use crate::organizer;

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
    // 出力先ディレクトリの決定とオーガナイザー使用判定。
    let organize_root = db.organize_root();
    let output_dir_given = req.output_dir.as_ref().filter(|d| !d.is_empty());
    let use_organizer = output_dir_given.is_none() && organize_root.is_some();

    let (output_dir, is_temp) = if let Some(given) = output_dir_given {
        // 明示的な出力先が指定されている: 従来パス。
        let p = PathBuf::from(given);
        std::fs::create_dir_all(&p)
            .map_err(|e| format!("Failed to create output dir: {}", e))?;
        (p, false)
    } else if use_organizer {
        // 出力先なし + organize 有効: temp へ rip して後で整理。
        let p = std::env::temp_dir()
            .join(format!("crateforge-rip-{}", std::process::id()));
        std::fs::create_dir_all(&p)
            .map_err(|e| format!("Failed to create temp dir: {}", e))?;
        (p, true)
    } else {
        return Err(
            "Output directory not specified and library organization is not configured. \
             Please set a library root in Settings or provide an output directory."
                .to_string(),
        );
    };

    // temp dir を使った場合、関数がどこで return しても必ず後始末する。
    struct TempDirGuard<'a> {
        dir: &'a std::path::Path,
        active: bool,
    }
    impl Drop for TempDirGuard<'_> {
        fn drop(&mut self) {
            if self.active {
                let _ = std::fs::remove_dir_all(self.dir);
            }
        }
    }
    let _temp_guard = TempDirGuard {
        dir: &output_dir,
        active: is_temp,
    };

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

        // 5. organize 有効時: ファイルをライブラリルート配下へ移動。
        let final_path_str = if use_organizer {
            let root_path = PathBuf::from(organize_root.as_ref().unwrap());
            let org_meta = organizer::TrackMeta {
                title,
                artist: track_artist,
                album_artist,
                album,
                compilation: album_artist
                    .map(|a| a.eq_ignore_ascii_case("various artists"))
                    .unwrap_or(false),
                track_number: Some(track_num as i64),
                disc_number: Some(1),
                disc_count: Some(1),
            };
            let target = organizer::target_path(&root_path, &org_meta, &out_path);
            let final_path = organizer::relocate(&out_path, &target, organizer::Mode::Move)
                .map_err(|e| format!("organize failed: {}", e))?;
            final_path.to_string_lossy().to_string()
        } else {
            out_path.to_string_lossy().to_string()
        };

        written_files.push(final_path_str.clone());

        // 6. Optionally add to library DB.
        if req.add_to_library {
            let location_url = path_to_file_url(&final_path_str);
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
                &final_path_str,
                &location_url,
            )
            .map_err(|e| format!("DB insert failed: {}", e))?;
            added_tracks += 1;
        }

        let _ = app.emit(
            "rip-progress",
            RipProgress::TrackDone {
                index: idx,
                output_path: final_path_str,
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
