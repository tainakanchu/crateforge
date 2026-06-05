//! 既存ライブラリ曲の音声フォーマット変換 (ffmpeg)。
//!
//! CD リッパーの encoder は WAV 入力前提 (lame/flac バイナリ) なので、
//! 任意フォーマット (flac/m4a/opus…) を入力にできる ffmpeg をここで使う。
//! 進捗は `convert-progress` イベントで配信する。

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Emitter};

use crate::db::Database;
use crate::importer;
use crate::models::{ConvertFormat, ConvertProgress, ConvertRequest, Track};

/// 指定トラックを順に変換する。`add_to_library` ならその場参照で DB へ追加する。
pub fn convert_tracks(app: &AppHandle, db: &Database, req: ConvertRequest) -> Result<(), String> {
    let out_dir = PathBuf::from(&req.output_dir);
    if out_dir.as_os_str().is_empty() {
        return Err("Output folder is required".to_string());
    }
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Creating output folder failed: {}", e))?;

    let mut jobs: Vec<Track> = Vec::new();
    for id in &req.track_ids {
        if let Ok(Some(t)) = db.get_track_by_track_id(*id) {
            jobs.push(t);
        }
    }

    let total = jobs.len();
    let _ = app.emit("convert-progress", ConvertProgress::Start { total });

    // Windows ではバンドルした ffmpeg.exe を優先、無ければ PATH の `ffmpeg`。
    let ffmpeg = ffmpeg_program(app);

    let mut converted = 0usize;
    let mut failed = 0usize;
    let mut added = 0usize;

    for (i, t) in jobs.iter().enumerate() {
        let name = t
            .name
            .clone()
            .unwrap_or_else(|| format!("track {}", t.track_id));

        let result = convert_one(&out_dir, t, req.format, req.bitrate_kbps, &ffmpeg);
        let ok = result.is_ok();
        match result {
            Ok(out_path) => {
                converted += 1;
                if req.add_to_library && importer::import_in_place(db, &out_path).is_ok() {
                    added += 1;
                }
            }
            Err(e) => {
                failed += 1;
                eprintln!("convert: track {} failed: {}", t.track_id, e);
            }
        }

        let _ = app.emit(
            "convert-progress",
            ConvertProgress::Item {
                index: i + 1,
                total,
                name,
                ok,
            },
        );
    }

    let _ = app.emit(
        "convert-progress",
        ConvertProgress::Done {
            converted,
            failed,
            added,
        },
    );
    Ok(())
}

/// 使用する ffmpeg のパスを解決する。Windows ではバンドルされた resource の
/// ffmpeg.exe を優先し、無ければ PATH 上の `ffmpeg` にフォールバックする。
fn ffmpeg_program(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        if let Ok(dir) = app.path().resource_dir() {
            let p = dir.join("ffmpeg.exe");
            if p.exists() {
                return p;
            }
        }
    }
    let _ = app;
    PathBuf::from("ffmpeg")
}

fn convert_one(
    out_dir: &Path,
    t: &Track,
    format: ConvertFormat,
    bitrate: Option<u32>,
    ffmpeg: &Path,
) -> Result<PathBuf, String> {
    let input = t.location_path.as_deref().ok_or("No file path for track")?;
    let input_path = Path::new(input);
    if !input_path.exists() {
        return Err("Source file not found".to_string());
    }

    let stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track");
    let out_path = unique_path(out_dir, stem, format.extension());

    // カバー対応フォーマットはまずカバー保持で試し、失敗したら無しで再試行。
    if format.supports_cover()
        && run_ffmpeg(ffmpeg, input_path, &out_path, format, bitrate, t, true).is_ok()
    {
        return Ok(out_path);
    }
    run_ffmpeg(ffmpeg, input_path, &out_path, format, bitrate, t, false)?;
    Ok(out_path)
}

/// 衝突しないパスを返す (`name.ext`, `name (2).ext`, …)。
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    p
}

#[allow(clippy::too_many_arguments)]
fn run_ffmpeg(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    format: ConvertFormat,
    bitrate: Option<u32>,
    t: &Track,
    with_cover: bool,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y").arg("-loglevel").arg("error");
    cmd.arg("-i").arg(input);

    if with_cover {
        // 音声 + (あれば) カバー画像をマップ。`?` で動画ストリームが無くても失敗しない。
        cmd.args(["-map", "0:a:0", "-map", "0:v?", "-c:v", "copy"]);
    } else {
        cmd.arg("-vn");
    }

    match format {
        ConvertFormat::Mp3 => {
            cmd.args(["-c:a", "libmp3lame", "-b:a"]);
            cmd.arg(format!("{}k", bitrate.unwrap_or(320)));
            cmd.args(["-id3v2_version", "3"]);
        }
        ConvertFormat::Flac => {
            cmd.args(["-c:a", "flac", "-compression_level", "8"]);
        }
        ConvertFormat::Alac => {
            cmd.args(["-c:a", "alac"]);
        }
        ConvertFormat::Aac => {
            cmd.args(["-c:a", "aac", "-b:a"]);
            cmd.arg(format!("{}k", bitrate.unwrap_or(256)));
        }
        ConvertFormat::Opus => {
            cmd.args(["-c:a", "libopus", "-b:a"]);
            cmd.arg(format!("{}k", bitrate.unwrap_or(192)));
        }
        ConvertFormat::Wav => {
            cmd.args(["-c:a", "pcm_s16le"]);
        }
    }

    // ソースのタグを引き継ぎつつ、ライブラリ (DB) の値で主要フィールドを上書き。
    cmd.args(["-map_metadata", "0"]);
    let meta: [(&str, Option<&str>); 6] = [
        ("title", t.name.as_deref()),
        ("artist", t.artist.as_deref()),
        ("album", t.album.as_deref()),
        ("album_artist", t.album_artist.as_deref()),
        ("genre", t.genre.as_deref()),
        ("composer", t.composer.as_deref()),
    ];
    for (k, v) in meta {
        if let Some(val) = v {
            cmd.arg("-metadata").arg(format!("{k}={val}"));
        }
    }
    if let Some(y) = t.year {
        cmd.arg("-metadata").arg(format!("date={y}"));
    }
    if let Some(n) = t.track_number {
        let s = match t.track_count {
            Some(c) => format!("{n}/{c}"),
            None => n.to_string(),
        };
        cmd.arg("-metadata").arg(format!("track={s}"));
    }
    if let Some(b) = t.bpm {
        cmd.arg("-metadata").arg(format!("TBPM={b}"));
    }

    cmd.arg(output);

    let status = cmd.status().map_err(|e| {
        format!("`ffmpeg` not found ({e}). Make sure it's in PATH (use `nix develop`).")
    })?;
    if !status.success() {
        // 失敗時は中途半端な出力を消しておく。
        let _ = std::fs::remove_file(output);
        return Err(format!("ffmpeg exited with {status}"));
    }
    Ok(())
}
