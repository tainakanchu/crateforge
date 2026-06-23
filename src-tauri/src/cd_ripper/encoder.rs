use std::path::Path;
use std::process::Command;

use crate::models::EncodeFormat;

pub struct EncodeMeta<'a> {
    pub title: Option<&'a str>,
    pub artist: Option<&'a str>,
    pub album: Option<&'a str>,
    pub album_artist: Option<&'a str>,
    pub track_number: Option<u32>,
    pub track_count: Option<u32>,
    pub date: Option<&'a str>,
}

/// WAV から各フォーマットへエンコードする。
///
/// `ffmpeg` に Some(パス) を渡すと、FLAC/MP3/ALAC をすべてその ffmpeg 経由で
/// エンコードする（flac / lame CLI が無い Windows 向け。ffmpeg は別途自動 DL 済み）。
/// None のときは従来どおり `flac` / `lame` / `ffmpeg` を PATH から呼ぶ（Unix）。
pub fn encode(
    format: EncodeFormat,
    input: &Path,
    output: &Path,
    meta: &EncodeMeta,
    ffmpeg: Option<&Path>,
) -> Result<(), String> {
    if format == EncodeFormat::Wav {
        std::fs::copy(input, output).map_err(|e| format!("Copy failed: {}", e))?;
        return Ok(());
    }
    if let Some(ff) = ffmpeg {
        return encode_with_ffmpeg(ff, format, input, output, meta);
    }
    match format {
        EncodeFormat::Wav => unreachable!(),
        EncodeFormat::Flac => encode_flac(input, output, meta),
        EncodeFormat::Mp3 => encode_mp3(input, output, meta),
        EncodeFormat::Alac => encode_alac(input, output, meta),
    }
}

/// 指定パスの ffmpeg で FLAC/MP3/ALAC へエンコードする。
fn encode_with_ffmpeg(
    ffmpeg: &Path,
    format: EncodeFormat,
    input: &Path,
    output: &Path,
    meta: &EncodeMeta,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y").arg("-loglevel").arg("error");
    cmd.arg("-i").arg(input);
    match format {
        EncodeFormat::Flac => {
            cmd.arg("-c:a")
                .arg("flac")
                .arg("-compression_level")
                .arg("8");
        }
        EncodeFormat::Mp3 => {
            cmd.arg("-c:a").arg("libmp3lame").arg("-b:a").arg("320k");
        }
        EncodeFormat::Alac => {
            cmd.arg("-c:a").arg("alac");
        }
        EncodeFormat::Wav => return Err("wav should be copied, not encoded".into()),
    }
    if let Some(t) = meta.title {
        cmd.arg("-metadata").arg(format!("title={}", t));
    }
    if let Some(a) = meta.artist {
        cmd.arg("-metadata").arg(format!("artist={}", a));
    }
    if let Some(al) = meta.album {
        cmd.arg("-metadata").arg(format!("album={}", al));
    }
    if let Some(aa) = meta.album_artist {
        cmd.arg("-metadata").arg(format!("album_artist={}", aa));
    }
    if let Some(d) = meta.date {
        cmd.arg("-metadata").arg(format!("date={}", d));
    }
    if let Some(n) = meta.track_number {
        let s = match meta.track_count {
            Some(c) => format!("{}/{}", n, c),
            None => n.to_string(),
        };
        cmd.arg("-metadata").arg(format!("track={}", s));
    }
    cmd.arg(output);
    run(cmd, "ffmpeg")
}

fn encode_flac(input: &Path, output: &Path, meta: &EncodeMeta) -> Result<(), String> {
    let mut cmd = Command::new("flac");
    cmd.arg("-f").arg("-8").arg("-s");
    if let Some(t) = meta.title {
        cmd.arg(format!("--tag=TITLE={}", t));
    }
    if let Some(a) = meta.artist {
        cmd.arg(format!("--tag=ARTIST={}", a));
    }
    if let Some(al) = meta.album {
        cmd.arg(format!("--tag=ALBUM={}", al));
    }
    if let Some(aa) = meta.album_artist {
        cmd.arg(format!("--tag=ALBUMARTIST={}", aa));
    }
    if let Some(d) = meta.date {
        cmd.arg(format!("--tag=DATE={}", d));
    }
    match (meta.track_number, meta.track_count) {
        (Some(n), Some(c)) => {
            cmd.arg(format!("--tag=TRACKNUMBER={}", n));
            cmd.arg(format!("--tag=TRACKTOTAL={}", c));
        }
        (Some(n), None) => {
            cmd.arg(format!("--tag=TRACKNUMBER={}", n));
        }
        _ => {}
    }
    cmd.arg("-o").arg(output).arg(input);

    run(cmd, "flac")
}

fn encode_mp3(input: &Path, output: &Path, meta: &EncodeMeta) -> Result<(), String> {
    let mut cmd = Command::new("lame");
    cmd.arg("-b").arg("320").arg("--quiet");
    if let Some(t) = meta.title {
        cmd.arg("--tt").arg(t);
    }
    if let Some(a) = meta.artist {
        cmd.arg("--ta").arg(a);
    }
    if let Some(al) = meta.album {
        cmd.arg("--tl").arg(al);
    }
    if let Some(d) = meta.date {
        cmd.arg("--ty").arg(d);
    }
    if let Some(n) = meta.track_number {
        let s = match meta.track_count {
            Some(c) => format!("{}/{}", n, c),
            None => n.to_string(),
        };
        cmd.arg("--tn").arg(s);
    }
    cmd.arg(input).arg(output);

    run(cmd, "lame")
}

fn encode_alac(input: &Path, output: &Path, meta: &EncodeMeta) -> Result<(), String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-y").arg("-loglevel").arg("error");
    cmd.arg("-i").arg(input);
    cmd.arg("-c:a").arg("alac");
    if let Some(t) = meta.title {
        cmd.arg("-metadata").arg(format!("title={}", t));
    }
    if let Some(a) = meta.artist {
        cmd.arg("-metadata").arg(format!("artist={}", a));
    }
    if let Some(al) = meta.album {
        cmd.arg("-metadata").arg(format!("album={}", al));
    }
    if let Some(aa) = meta.album_artist {
        cmd.arg("-metadata").arg(format!("album_artist={}", aa));
    }
    if let Some(d) = meta.date {
        cmd.arg("-metadata").arg(format!("date={}", d));
    }
    if let Some(n) = meta.track_number {
        let s = match meta.track_count {
            Some(c) => format!("{}/{}", n, c),
            None => n.to_string(),
        };
        cmd.arg("-metadata").arg(format!("track={}", s));
    }
    cmd.arg(output);

    run(cmd, "ffmpeg")
}

fn run(mut cmd: Command, name: &str) -> Result<(), String> {
    // Windows でコンソール窓を出さない (課題1)。flac/lame/ffmpeg いずれもここを通る。
    crate::proc::no_window(&mut cmd);
    let status = cmd.status().map_err(|e| {
        format!(
            "`{}` not found ({}). Make sure it's in PATH (use `nix develop`).",
            name, e
        )
    })?;
    if !status.success() {
        return Err(format!("{} exited with status {}", name, status));
    }
    Ok(())
}
