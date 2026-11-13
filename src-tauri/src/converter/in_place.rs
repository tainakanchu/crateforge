//! 変換して置き換え: ライブラリの曲をその場で別フォーマットへ変換し、同じ曲 (行) を
//! 新しいファイルへ付け替える。
//!
//! 1 曲ごとの流れ ([`replace_one`]):
//! 1. 元ファイルのコーデック・ビットレート・長さを実ファイルから読む
//!    (MP4 は AAC / ALAC をコンテナではなく実コーデックで判定する)。
//! 2. すでに変換先と同じコーデックで、ビットレートも同じか低い (= 何もしないのと同じ) なら
//!    スキップする。非可逆 → 非可逆は世代劣化するので `lossy_to_lossy` の警告を付ける (拒否はしない)。
//! 3. 元ファイルの隣に同じ名前・変換先の拡張子で ffmpeg で書き出す (既にあれば ` (2)` 等)。
//! 4. 元ファイルのタグ (取れるものすべて) と埋め込みアートワークを新ファイルへ写す。
//! 5. 新ファイルを最後までデコードでき、長さが元とほぼ同じかを確かめる。
//! 6. [`replace::finalize_replacement`] で同じ行 (track_id / persistent_id / 再生回数 /
//!    レート / プレイリスト / 編集したタグはそのまま) を新ファイルへ付け替え、
//!    元ファイルをゴミ箱 (既定) か `_replaced/<日付>/` へ移す。他の曲も参照している
//!    元ファイルには触れない。
//!
//! 3〜6 のどこかで失敗したら、作りかけの新ファイルを消し、元ファイル・行には手を付けない。

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Command;

use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::library_match::replace::{self, NewFile, OldFileDisposition, OldFilePolicy, TrashFn};
use crate::models::ConvertFormat;

/// 長さの一致とみなす許容差 (ms)。MP3 のエンコーダ遅延・パディング (数十 ms) を吸収する。
pub const DURATION_TOLERANCE_MS: i64 = 500;

/// 置き換え後の元ファイルの扱い (API / UI 共通)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OriginalAction {
    /// OS のゴミ箱へ移す (既定)。
    #[default]
    Trash,
    /// `_replaced/<YYYYMMDD>/` へ移す。
    Replaced,
}

/// 変換して置き換えの指定。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InPlaceOptions {
    pub format: ConvertFormat,
    /// 非可逆フォーマットのビットレート (kbps)。None なら既定値 (MP3 は 320)。
    pub bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub original: OriginalAction,
}

impl InPlaceOptions {
    /// 実際に使うビットレート (可逆フォーマットでは None)。
    pub fn effective_bitrate(&self) -> Option<u32> {
        match self.format {
            ConvertFormat::Mp3 => Some(self.bitrate_kbps.unwrap_or(320)),
            ConvertFormat::Aac => Some(self.bitrate_kbps.unwrap_or(256)),
            ConvertFormat::Opus => Some(self.bitrate_kbps.unwrap_or(192)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Ok,
    Skipped,
    Failed,
}

/// 1 曲分の結果。`reason` は機械可読なコード、`message` は人向けの説明。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub track_id: i64,
    pub name: Option<String>,
    pub status: ItemStatus,
    /// skipped / failed の理由コード (`already_target_format` / `not_found` / `no_file` /
    /// `probe_failed` / `encode_failed` / `tag_copy_failed` / `decode_failed` /
    /// `duration_mismatch` / `replace_failed`)。
    pub reason: Option<String>,
    pub message: Option<String>,
    /// 失敗ではない注意 (`lossy_to_lossy` / `trash_failed`)。
    pub warnings: Vec<String>,
    /// 実ファイルから判定した元のコーデック ("ALAC" / "AAC" / "FLAC" / "MP3" …)。
    pub source_codec: Option<String>,
    pub source_lossless: Option<bool>,
    pub old_location_path: Option<String>,
    pub new_location_path: Option<String>,
    /// 元ファイルの扱い (成功時のみ)。
    pub original: Option<OldFileDisposition>,
}

impl ItemResult {
    fn new(track_id: i64) -> Self {
        Self {
            track_id,
            name: None,
            status: ItemStatus::Failed,
            reason: None,
            message: None,
            warnings: Vec::new(),
            source_codec: None,
            source_lossless: None,
            old_location_path: None,
            new_location_path: None,
            original: None,
        }
    }

    fn fail(mut self, reason: &str, message: impl Into<String>) -> Self {
        self.status = ItemStatus::Failed;
        self.reason = Some(reason.to_string());
        self.message = Some(message.into());
        self
    }
}

/// 実ファイルから読んだ元ファイルの情報。
#[derive(Debug, Clone, PartialEq)]
pub struct SourceInfo {
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    pub duration_ms: Option<i64>,
}

/// コーデック表示名が可逆 (または無圧縮) か。
pub fn is_lossless_codec(codec: &str) -> bool {
    matches!(
        codec,
        "FLAC" | "ALAC" | "WAV" | "AIFF" | "WavPack" | "APE"
    )
}

/// 変換先フォーマットのコーデック表示名 (`metadata::tech::codec_label` と同じ表記)。
pub fn target_codec(format: ConvertFormat) -> &'static str {
    match format {
        ConvertFormat::Mp3 => "MP3",
        ConvertFormat::Aac => "AAC",
        ConvertFormat::Alac => "ALAC",
        ConvertFormat::Flac => "FLAC",
        ConvertFormat::Wav => "WAV",
        ConvertFormat::Opus => "Opus",
    }
}

/// 変換しても意味が無い (同じコーデックで、ビットレートも同じか低い) か。
/// 非可逆でビットレートが分からないときも、劣化させないよう何もしない側に倒す。
pub fn is_noop(source: &SourceInfo, opts: &InPlaceOptions) -> bool {
    if source.codec != target_codec(opts.format) {
        return false;
    }
    match opts.effective_bitrate() {
        None => true,
        // 実測ビットレートはヘッダ分などで公称値より少し高く出る (320k CBR が 322 等) ので 3% 許す。
        Some(target) => source
            .bitrate_kbps
            .is_none_or(|b| u64::from(b) * 100 <= u64::from(target) * 103),
    }
}

/// 非可逆 → 非可逆 (世代劣化) か。
pub fn is_lossy_to_lossy(source_codec: &str, format: ConvertFormat) -> bool {
    !is_lossless_codec(source_codec) && !is_lossless_codec(target_codec(format))
}

/// 元ファイルのコーデック・ビットレート・長さを読む。MP4 は実コーデックで AAC / ALAC を判定する。
pub fn probe_source(path: &Path) -> Result<SourceInfo, String> {
    let tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {e}"))?
        .options(ParseOptions::new().read_tags(false).read_cover_art(false))
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;
    let props = tagged.properties();
    let codec = if tagged.file_type() == FileType::Mp4 {
        mp4_codec(path).unwrap_or_else(|| {
            crate::metadata::tech::codec_label(&FileType::Mp4, props.bit_depth())
        })
    } else {
        crate::metadata::tech::codec_label(&tagged.file_type(), props.bit_depth())
    };
    let bitrate = props
        .audio_bitrate()
        .or(props.overall_bitrate())
        .filter(|&b| b > 0);
    let ms = props.duration().as_millis() as i64;
    Ok(SourceInfo {
        codec,
        bitrate_kbps: bitrate,
        duration_ms: Some(ms).filter(|&m| m > 0),
    })
}

fn mp4_codec(path: &Path) -> Option<String> {
    use lofty::mp4::{Mp4Codec, Mp4File};
    let mut f = File::open(path).ok()?;
    let mp4 = Mp4File::read_from(
        &mut f,
        ParseOptions::new().read_tags(false).read_cover_art(false),
    )
    .ok()?;
    match mp4.properties().codec() {
        Mp4Codec::AAC => Some("AAC".into()),
        Mp4Codec::ALAC => Some("ALAC".into()),
        Mp4Codec::FLAC => Some("FLAC".into()),
        Mp4Codec::MP3 => Some("MP3".into()),
        _ => None,
    }
}

/// 出力先を決める。`(書き出すパス, 本来の名前)`。本来の名前が空いていればそのまま、
/// 塞がっていれば ` (2)` 等で書き出し、元ファイルが退いた後に本来の名前へ改名させる
/// (同じ拡張子の変換、例: ALAC .m4a → AAC .m4a)。
pub fn output_paths(source: &Path, format: ConvertFormat) -> (PathBuf, PathBuf) {
    let dir = source.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track");
    let desired = dir.join(format!("{stem}.{}", format.extension()));
    let staged = super::unique_path(&dir, stem, format.extension());
    (staged, desired)
}

/// ffmpeg で音声だけを書き出す (タグは後で lofty で写す)。
pub fn encode(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    opts: &InPlaceOptions,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i"]);
    cmd.arg(input);
    cmd.args(["-map", "0:a:0", "-map_metadata", "-1"]);
    super::push_codec_args(&mut cmd, opts.format, opts.effective_bitrate());
    cmd.arg(output);
    crate::proc::no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("ffmpeg を起動できませんでした ({e})"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(output);
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("ffmpeg exited with {} {}", out.status, last.trim()));
    }
    Ok(())
}

/// 元ファイルのタグ項目とアートワークを、新ファイルのタグ形式に写し替えて保存する。
/// 変換先の形式で表せない項目は落ちる。エンコーダ情報は元ファイルのものなので写さない。
pub fn copy_tags(source: &Path, dest: &Path) -> Result<(), String> {
    let src = Probe::open(source)
        .map_err(|e| format!("open failed: {e}"))?
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;
    let mut dst = Probe::open(dest)
        .map_err(|e| format!("open failed: {e}"))?
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;
    let tag_type = dst.primary_tag_type();
    let mut tag = Tag::new(tag_type);
    // 主タグを先に写し、他のタグ (例: FLAC の ID3) は主タグに無い項目だけ補う。
    let primary = src.primary_tag().or_else(|| src.first_tag());
    let mut sources: Vec<&Tag> = primary.into_iter().collect();
    sources.extend(
        src.tags()
            .iter()
            .filter(|t| !primary.is_some_and(|p| std::ptr::eq(p, *t))),
    );
    for (i, src_tag) in sources.iter().enumerate() {
        for item in src_tag.items() {
            // エンコーダ情報は元ファイルのものなので写さない。
            if matches!(
                item.key(),
                ItemKey::EncoderSoftware | ItemKey::EncoderSettings | ItemKey::EncodedBy
            ) {
                continue;
            }
            if i > 0 && tag.get(item.key()).is_some() {
                continue;
            }
            // push は複数値 (複数アーティスト等) を保ち、変換先で表せない項目は捨てる。
            tag.push(item.clone());
        }
        if tag.pictures().is_empty() {
            for pic in src_tag.pictures() {
                tag.push_picture(pic.clone());
            }
        }
    }
    // ffmpeg が書いた同じ種類のタグ (エンコーダ名など) は丸ごと置き換える。
    dst.insert_tag(tag);
    dst.save_to_path(dest, WriteOptions::default())
        .map_err(|e| format!("save tags failed: {e}"))
}

/// ファイルを最後までデコードし、実際に出てきた音声の長さ (ms) を返す。
/// デコードエラーが 1 つでもあれば失敗にする。
pub fn decoded_duration_ms(path: &Path) -> Result<i64, String> {
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as SymError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe failed: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no decodable audio track")?;
    let track_id = track.id;
    let rate = track.codec_params.sample_rate.ok_or("unknown sample rate")? as u64;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder init failed: {e}"))?;
    let mut frames: u64 = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(format!("read failed: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|e| format!("decode failed: {e}"))?;
        frames += decoded.frames() as u64;
    }
    if frames == 0 {
        return Err("no audio decoded".to_string());
    }
    Ok((frames * 1000 / rate) as i64)
}

/// 新ファイルを検証する: 最後までデコードでき、長さが期待値 (分かれば) と許容差内か。
pub fn verify_output(path: &Path, expected_ms: Option<i64>) -> Result<i64, (&'static str, String)> {
    let got = decoded_duration_ms(path).map_err(|e| ("decode_failed", e))?;
    if let Some(exp) = expected_ms {
        if (got - exp).abs() > DURATION_TOLERANCE_MS {
            return Err((
                "duration_mismatch",
                format!("長さが一致しません (元 {exp} ms / 変換後 {got} ms)"),
            ));
        }
    }
    Ok(got)
}

/// 1 曲を変換して置き換える。詳細はモジュール冒頭を参照。
pub fn replace_one(
    db: &Database,
    track_id: i64,
    ffmpeg: &Path,
    opts: &InPlaceOptions,
    library_root: Option<&Path>,
    trash: TrashFn,
) -> ItemResult {
    let mut r = ItemResult::new(track_id);
    let track = match db.get_track_by_track_id(track_id) {
        Ok(Some(t)) => t,
        Ok(None) => return r.fail("not_found", "曲が見つかりません"),
        Err(e) => return r.fail("not_found", e.to_string()),
    };
    r.name = track.name.clone();
    let Some(src) = track
        .location_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
    else {
        return r.fail("no_file", "ファイルの場所がありません");
    };
    r.old_location_path = Some(src.to_string_lossy().to_string());
    if !src.is_file() {
        return r.fail("no_file", "ファイルが見つかりません");
    }

    let info = match probe_source(&src) {
        Ok(i) => i,
        Err(e) => return r.fail("probe_failed", e),
    };
    r.source_codec = Some(info.codec.clone());
    r.source_lossless = Some(is_lossless_codec(&info.codec));
    if is_noop(&info, opts) {
        r.status = ItemStatus::Skipped;
        r.reason = Some("already_target_format".to_string());
        r.message = Some(format!("すでに {}", info.codec));
        return r;
    }
    if is_lossy_to_lossy(&info.codec, opts.format) {
        r.warnings.push("lossy_to_lossy".to_string());
    }

    let (staged, desired) = output_paths(&src, opts.format);
    if let Err(e) = encode(ffmpeg, &src, &staged, opts) {
        let _ = std::fs::remove_file(&staged);
        return r.fail("encode_failed", e);
    }
    if let Err(e) = copy_tags(&src, &staged) {
        let _ = std::fs::remove_file(&staged);
        return r.fail("tag_copy_failed", e);
    }
    let expected = info.duration_ms.or(track.total_time_ms.filter(|&m| m > 0));
    if let Err((code, e)) = verify_output(&staged, expected) {
        let _ = std::fs::remove_file(&staged);
        return r.fail(code, e);
    }

    let old_policy = match opts.original {
        OriginalAction::Trash => OldFilePolicy::Trash(trash),
        OriginalAction::Replaced => OldFilePolicy::MoveToReplaced,
    };
    match replace::finalize_replacement(
        db,
        track_id,
        NewFile {
            path: staged.clone(),
            owned: true,
            desired: Some(desired).filter(|d| *d != staged),
            library_root,
            old_policy,
        },
    ) {
        Ok(out) => {
            r.status = ItemStatus::Ok;
            r.new_location_path = Some(out.new_path);
            if let Some(e) = out.trash_error {
                r.warnings.push("trash_failed".to_string());
                r.message = Some(format!("ゴミ箱へ移せませんでした: {e}"));
            }
            r.original = Some(out.old_file);
            r
        }
        Err(e) => {
            // finalize_replacement は owned な新ファイルを自分で片付ける。
            let _ = std::fs::remove_file(&staged);
            r.fail("replace_failed", e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::itunes_xml::writer::path_to_file_url;
    use std::cell::RefCell;
    use tempfile::TempDir;

    fn ffmpeg() -> Option<PathBuf> {
        let ok = Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        ok.then(|| PathBuf::from("ffmpeg"))
    }

    /// ffmpeg で `secs` 秒のサイン波を書き出す (タグ付き)。
    fn gen_audio(ff: &Path, out: &Path, codec_args: &[&str], secs: u32) {
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        let mut cmd = Command::new(ff);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"]);
        cmd.arg(format!("sine=frequency=440:duration={secs}:sample_rate=44100"));
        cmd.args(codec_args);
        cmd.args([
            "-metadata", "title=Song",
            "-metadata", "artist=Artist",
            "-metadata", "album=Album",
            "-metadata", "composer=Composer",
            "-metadata", "lyrics=la la la",
            "-metadata", "comment=nice",
        ]);
        cmd.arg(out);
        let st = cmd.status().unwrap();
        assert!(st.success(), "fixture generation failed");
    }

    struct Fx {
        tmp: TempDir,
        root: PathBuf,
        db: Database,
    }

    fn fx() -> Fx {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("Music");
        Fx {
            root,
            db: Database::open_memory().unwrap(),
            tmp,
        }
    }

    fn add_track(db: &Database, path: &Path) -> i64 {
        let s = path.to_string_lossy().to_string();
        let id = db
            .add_imported_track(
                Some("Song (edited)"),
                Some("Artist"),
                Some("Artist"),
                Some("Album"),
                Some("Rock"),
                Some(2001),
                Some(1),
                Some(10),
                Some(1),
                Some(1),
                None,
                &s,
                &path_to_file_url(&s),
            )
            .unwrap();
        db.set_rating(id, 80).unwrap();
        db.mark_played(id).unwrap();
        id
    }

    /// 本物のゴミ箱を汚さないよう、テスト用の「ゴミ箱」フォルダへ移す。
    fn fake_trash(dir: PathBuf) -> impl Fn(&Path) -> Result<(), String> {
        move |p: &Path| {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::rename(p, dir.join(p.file_name().unwrap())).map_err(|e| e.to_string())
        }
    }

    fn failing_trash(_: &Path) -> Result<(), String> {
        Err("no trash here".to_string())
    }

    fn mp3_opts(original: OriginalAction) -> InPlaceOptions {
        InPlaceOptions {
            format: ConvertFormat::Mp3,
            bitrate_kbps: Some(320),
            original,
        }
    }

    fn src_info(codec: &str, br: Option<u32>) -> SourceInfo {
        SourceInfo {
            codec: codec.into(),
            bitrate_kbps: br,
            duration_ms: Some(1000),
        }
    }

    #[test]
    fn noop_and_lossy_rules() {
        let mp3 = mp3_opts(OriginalAction::Trash);
        // MP3 320 → MP3 320 / 低いビットレート / 不明 は何もしない。
        assert!(is_noop(&src_info("MP3", Some(320)), &mp3));
        assert!(is_noop(&src_info("MP3", Some(192)), &mp3));
        assert!(is_noop(&src_info("MP3", None), &mp3));
        // MP3 320 → MP3 192 は変換する (非可逆 → 非可逆の警告付き)。
        let low = InPlaceOptions {
            bitrate_kbps: Some(192),
            ..mp3
        };
        assert!(!is_noop(&src_info("MP3", Some(320)), &low));
        assert!(is_lossy_to_lossy("MP3", ConvertFormat::Mp3));
        // ALAC / AAC / FLAC → MP3 は変換する。AAC → MP3 は警告付き。
        assert!(!is_noop(&src_info("ALAC", Some(900)), &mp3));
        assert!(!is_noop(&src_info("AAC", Some(256)), &mp3));
        assert!(is_lossy_to_lossy("AAC", ConvertFormat::Mp3));
        assert!(!is_lossy_to_lossy("ALAC", ConvertFormat::Mp3));
        assert!(!is_lossy_to_lossy("AAC", ConvertFormat::Flac));
        // 可逆の同一コーデックはビットレートに関係なく何もしない。
        let flac = InPlaceOptions {
            format: ConvertFormat::Flac,
            bitrate_kbps: None,
            original: OriginalAction::Trash,
        };
        assert!(is_noop(&src_info("FLAC", Some(1000)), &flac));
        assert!(!is_noop(&src_info("ALAC", Some(1000)), &flac));
    }

    #[test]
    fn output_paths_use_same_stem_and_avoid_collisions() {
        let f = fx();
        let src = f.root.join("A/B/01 Song.m4a");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"x").unwrap();
        let (staged, desired) = output_paths(&src, ConvertFormat::Mp3);
        assert_eq!(staged, f.root.join("A/B/01 Song.mp3"));
        assert_eq!(desired, staged);
        // 既にある名前は避ける。
        std::fs::write(f.root.join("A/B/01 Song.mp3"), b"other").unwrap();
        let (staged, desired) = output_paths(&src, ConvertFormat::Mp3);
        assert_eq!(staged, f.root.join("A/B/01 Song (2).mp3"));
        assert_eq!(desired, f.root.join("A/B/01 Song.mp3"));
        // 同じ拡張子 (ALAC → AAC) は元ファイルと衝突するので一旦別名。
        let (staged, desired) = output_paths(&src, ConvertFormat::Aac);
        assert_eq!(staged, f.root.join("A/B/01 Song (2).m4a"));
        assert_eq!(desired, src);
    }

    #[test]
    fn missing_file_and_unknown_track_fail_without_side_effects() {
        let f = fx();
        let gone = f.root.join("gone.flac");
        let id = add_track(&f.db, &gone);
        let r = replace_one(
            &f.db,
            id,
            Path::new("ffmpeg"),
            &mp3_opts(OriginalAction::Trash),
            Some(&f.root),
            &failing_trash,
        );
        assert_eq!(r.status, ItemStatus::Failed);
        assert_eq!(r.reason.as_deref(), Some("no_file"));
        let r = replace_one(
            &f.db,
            9999,
            Path::new("ffmpeg"),
            &mp3_opts(OriginalAction::Trash),
            None,
            &failing_trash,
        );
        assert_eq!(r.reason.as_deref(), Some("not_found"));
    }

    #[test]
    fn encode_failure_leaves_original_and_row_untouched() {
        let f = fx();
        let src = f.root.join("A/B/01 Song.wav");
        crate::library_match::replace::tests::write_wav(&src, 2);
        let id = add_track(&f.db, &src);
        let before = f.db.get_track_by_track_id(id).unwrap().unwrap();
        let r = replace_one(
            &f.db,
            id,
            Path::new("/nonexistent/ffmpeg"),
            &mp3_opts(OriginalAction::Trash),
            Some(&f.root),
            &failing_trash,
        );
        assert_eq!(r.status, ItemStatus::Failed);
        assert_eq!(r.reason.as_deref(), Some("encode_failed"));
        assert_eq!(r.source_codec.as_deref(), Some("WAV"));
        assert!(src.is_file());
        assert!(!f.root.join("A/B/01 Song.mp3").exists());
        let after = f.db.get_track_by_track_id(id).unwrap().unwrap();
        assert_eq!(after.location_path, before.location_path);
    }

    #[test]
    fn bogus_output_fails_verification() {
        let f = fx();
        let p = f.tmp.path().join("bogus.mp3");
        std::fs::write(&p, b"definitely not audio").unwrap();
        assert!(verify_output(&p, Some(1000)).is_err());
    }

    #[test]
    fn alac_to_mp3_keeps_row_identity_tags_and_art_and_trashes_original() {
        let Some(ff) = ffmpeg() else {
            eprintln!("skip: ffmpeg not found");
            return;
        };
        let f = fx();
        let src = f.root.join("Artist/Album/01 Song.m4a");
        gen_audio(&ff, &src, &["-c:a", "alac"], 3);
        // iTunes と同じ covr atom のカバーを付ける。
        let jpeg = f.tmp.path().join("cover.jpg");
        let st = Command::new(&ff)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .args(["color=c=red:s=16x16:d=1", "-frames:v", "1"])
            .arg(&jpeg)
            .status()
            .unwrap();
        assert!(st.success());
        crate::artwork::set_picture(&src.to_string_lossy(), std::fs::read(&jpeg).unwrap())
            .unwrap();
        assert_eq!(probe_source(&src).unwrap().codec, "ALAC");
        let id = add_track(&f.db, &src);
        let pid = f.db.get_track_by_track_id(id).unwrap().unwrap().persistent_id;
        let playlist = f.db.create_playlist("P", None, false).unwrap().playlist_id;
        f.db.add_tracks_to_playlist(playlist, &[id]).unwrap();

        let trash_dir = f.tmp.path().join("trash");
        let trash = fake_trash(trash_dir.clone());
        let r = replace_one(
            &f.db,
            id,
            &ff,
            &mp3_opts(OriginalAction::Trash),
            Some(&f.root),
            &trash,
        );
        assert_eq!(r.status, ItemStatus::Ok, "{r:?}");
        assert!(r.warnings.is_empty());
        assert_eq!(r.source_lossless, Some(true));
        let new_path = f.root.join("Artist/Album/01 Song.mp3");
        assert_eq!(r.new_location_path.as_deref(), Some(new_path.to_str().unwrap()));
        assert_eq!(r.original, Some(OldFileDisposition::Trashed));
        assert!(!src.exists());
        assert!(trash_dir.join("01 Song.m4a").is_file());

        // 同じ行のまま (id / persistent_id / レート / 再生回数 / プレイリスト)。
        let t = f.db.get_track_by_track_id(id).unwrap().unwrap();
        assert_eq!(t.persistent_id, pid);
        assert_eq!(t.rating, Some(80));
        assert_eq!(t.play_count, Some(1));
        assert_eq!(t.location_path.as_deref(), new_path.to_str());
        assert_eq!(t.codec.as_deref(), Some("MP3"));
        // 短いファイルは実測ビットレートが公称値より少し高く出る。
        assert!((315..=330).contains(&t.bitrate_kbps.unwrap()));
        assert!((2_500..=3_500).contains(&t.total_time_ms.unwrap()));
        assert_eq!(f.db.get_playlist_track_ids(playlist).unwrap(), vec![id]);

        // タグ: 元ファイルのもの (歌詞・作曲者・コメント) + ライブラリの編集 (曲名) + カバー。
        let tagged = Probe::open(&new_path).unwrap().read().unwrap();
        let tag = tagged.primary_tag().unwrap();
        assert_eq!(tag.tag_type(), lofty::tag::TagType::Id3v2);
        use lofty::tag::Accessor;
        assert_eq!(tag.title().as_deref(), Some("Song (edited)"));
        assert_eq!(tag.get_string(&ItemKey::Lyrics), Some("la la la"));
        assert_eq!(tag.get_string(&ItemKey::Composer), Some("Composer"));
        assert_eq!(tag.get_string(&ItemKey::EncoderSoftware), None);
        assert!(!tag.pictures().is_empty(), "cover art is kept");
    }

    #[test]
    fn aac_to_mp3_is_allowed_with_warning_and_keep_in_replaced() {
        let Some(ff) = ffmpeg() else {
            eprintln!("skip: ffmpeg not found");
            return;
        };
        let f = fx();
        let src = f.root.join("Artist/Album/02 Song.m4a");
        gen_audio(&ff, &src, &["-c:a", "aac", "-b:a", "128k"], 2);
        assert_eq!(probe_source(&src).unwrap().codec, "AAC");
        let id = add_track(&f.db, &src);
        let r = replace_one(
            &f.db,
            id,
            &ff,
            &mp3_opts(OriginalAction::Replaced),
            Some(&f.root),
            &failing_trash,
        );
        assert_eq!(r.status, ItemStatus::Ok, "{r:?}");
        assert_eq!(r.warnings, vec!["lossy_to_lossy".to_string()]);
        let Some(OldFileDisposition::Moved { to }) = &r.original else {
            panic!("expected moved: {:?}", r.original)
        };
        assert!(Path::new(to).starts_with(f.root.join("_replaced")));
        assert!(Path::new(to).ends_with("Artist/Album/02 Song.m4a"));
        assert!(!src.exists());
    }

    #[test]
    fn mp3_320_to_mp3_320_is_skipped() {
        let Some(ff) = ffmpeg() else {
            eprintln!("skip: ffmpeg not found");
            return;
        };
        let f = fx();
        let src = f.root.join("A/B/03.mp3");
        gen_audio(&ff, &src, &["-c:a", "libmp3lame", "-b:a", "320k"], 2);
        let id = add_track(&f.db, &src);
        let r = replace_one(
            &f.db,
            id,
            &ff,
            &mp3_opts(OriginalAction::Trash),
            Some(&f.root),
            &failing_trash,
        );
        assert_eq!(r.status, ItemStatus::Skipped);
        assert_eq!(r.reason.as_deref(), Some("already_target_format"));
        assert!(src.is_file());
        assert!(!f.root.join("A/B/03 (2).mp3").exists());
    }

    #[test]
    fn shared_original_is_never_touched() {
        let Some(ff) = ffmpeg() else {
            eprintln!("skip: ffmpeg not found");
            return;
        };
        let f = fx();
        let src = f.root.join("A/B/04.flac");
        gen_audio(&ff, &src, &["-c:a", "flac"], 2);
        let id = add_track(&f.db, &src);
        let _other = add_track(&f.db, &src);
        let trashed = RefCell::new(Vec::<PathBuf>::new());
        let spy = |p: &Path| {
            trashed.borrow_mut().push(p.to_path_buf());
            Ok(())
        };
        let r = replace_one(
            &f.db,
            id,
            &ff,
            &mp3_opts(OriginalAction::Trash),
            Some(&f.root),
            &spy,
        );
        assert_eq!(r.status, ItemStatus::Ok, "{r:?}");
        assert_eq!(r.original, Some(OldFileDisposition::KeptShared));
        assert!(trashed.borrow().is_empty());
        assert!(src.is_file());
    }

    #[test]
    fn trash_failure_falls_back_to_replaced_folder() {
        let Some(ff) = ffmpeg() else {
            eprintln!("skip: ffmpeg not found");
            return;
        };
        let f = fx();
        let src = f.root.join("A/B/05.flac");
        gen_audio(&ff, &src, &["-c:a", "flac"], 2);
        let id = add_track(&f.db, &src);
        let r = replace_one(
            &f.db,
            id,
            &ff,
            &mp3_opts(OriginalAction::Trash),
            Some(&f.root),
            &failing_trash,
        );
        assert_eq!(r.status, ItemStatus::Ok, "{r:?}");
        assert!(r.warnings.contains(&"trash_failed".to_string()));
        assert!(matches!(r.original, Some(OldFileDisposition::Moved { .. })));
        assert!(!src.exists());
    }

    #[test]
    fn same_extension_conversion_takes_over_original_name() {
        let Some(ff) = ffmpeg() else {
            eprintln!("skip: ffmpeg not found");
            return;
        };
        let f = fx();
        let src = f.root.join("A/B/06.m4a");
        gen_audio(&ff, &src, &["-c:a", "alac"], 2);
        let id = add_track(&f.db, &src);
        let trash = fake_trash(f.tmp.path().join("trash"));
        let opts = InPlaceOptions {
            format: ConvertFormat::Aac,
            bitrate_kbps: Some(256),
            original: OriginalAction::Trash,
        };
        let r = replace_one(&f.db, id, &ff, &opts, Some(&f.root), &trash);
        assert_eq!(r.status, ItemStatus::Ok, "{r:?}");
        assert_eq!(r.new_location_path.as_deref(), src.to_str());
        assert_eq!(probe_source(&src).unwrap().codec, "AAC");
        assert!(!f.root.join("A/B/06 (2).m4a").exists());
        let t = f.db.get_track_by_track_id(id).unwrap().unwrap();
        assert_eq!(t.location_path.as_deref(), src.to_str());
    }
}
