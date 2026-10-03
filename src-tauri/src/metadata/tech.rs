//! 音声ファイルの技術メタデータ (#171)。
//!
//! bitrate / sample rate / bit depth / channels / file size / codec を lofty の
//! `FileProperties` とファイルシステムから取得する。ユーザーが編集するタグ
//! (曲名・アーティスト等) とは独立した「ファイル由来の事実」なので、
//! 再読み取りで上書きしてよい列として扱う。

use std::path::Path;

use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::probe::Probe;
use lofty::properties::FileProperties;

/// ファイルから読み取った技術メタデータ。取得できない項目は None。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TechMeta {
    /// 音声ビットレート (kbps)。
    pub bitrate_kbps: Option<i64>,
    /// サンプルレート (Hz)。
    pub sample_rate_hz: Option<i64>,
    /// ビット深度 (ロスレス / PCM 系のみ。MP3/AAC 等は None)。
    pub bit_depth: Option<i64>,
    /// チャンネル数。
    pub channels: Option<i64>,
    /// ファイルサイズ (bytes)。
    pub file_size_bytes: Option<i64>,
    /// コーデック表示名 ("FLAC" / "MP3" / "AAC" / "ALAC" …)。
    pub codec: Option<String>,
}

/// lofty の FileType (+ MP4 の場合は bit depth の有無) からコーデック表示名を決める。
///
/// MP4 コンテナは AAC / ALAC (/ FLAC-in-MP4) のどれもあり得る。lofty は ALAC と FLAC の
/// ときだけ bit depth を埋め、AAC では None のままなので、追加の読み取り無しで
/// 「bit depth あり = ロスレス (ALAC)」「無し = AAC」と判定できる。
pub fn codec_label(file_type: &FileType, bit_depth: Option<u8>) -> String {
    match file_type {
        FileType::Aac => "AAC".to_string(),
        FileType::Aiff => "AIFF".to_string(),
        FileType::Ape => "APE".to_string(),
        FileType::Flac => "FLAC".to_string(),
        FileType::Mpeg => "MP3".to_string(),
        FileType::Mp4 => {
            if bit_depth.is_some() {
                "ALAC".to_string()
            } else {
                "AAC".to_string()
            }
        }
        FileType::Mpc => "MPC".to_string(),
        FileType::Opus => "Opus".to_string(),
        FileType::Vorbis => "Vorbis".to_string(),
        FileType::Speex => "Speex".to_string(),
        FileType::Wav => "WAV".to_string(),
        FileType::WavPack => "WavPack".to_string(),
        FileType::Custom(name) => name.to_string(),
        // FileType は non_exhaustive。未知の種別は Debug 表記で残す。
        #[allow(unreachable_patterns)]
        other => format!("{other:?}"),
    }
}

/// 0 は「不明」として扱う (lofty は取得できない値を 0 にすることがある)。
fn positive(v: Option<u32>) -> Option<i64> {
    v.filter(|&n| n > 0).map(i64::from)
}

/// 既に読み取り済みの lofty プロパティから TechMeta を組み立てる (取り込み時の再 probe を避ける)。
pub fn from_properties(
    file_type: &FileType,
    props: &FileProperties,
    file_size_bytes: Option<u64>,
) -> TechMeta {
    let bit_depth = props.bit_depth();
    TechMeta {
        // audio_bitrate を優先し、取れない形式では overall_bitrate にフォールバック。
        bitrate_kbps: positive(props.audio_bitrate()).or_else(|| positive(props.overall_bitrate())),
        sample_rate_hz: positive(props.sample_rate()),
        bit_depth: positive_u8(bit_depth),
        channels: positive_u8(props.channels()),
        file_size_bytes: file_size_bytes.map(|n| n as i64),
        codec: Some(codec_label(file_type, bit_depth)),
    }
}

fn positive_u8(v: Option<u8>) -> Option<i64> {
    v.filter(|&n| n > 0).map(i64::from)
}

/// ファイルを開いて技術メタデータを読む。タグは読まない (プロパティだけで十分)。
pub fn read_tech_meta(path: &Path) -> Result<TechMeta, String> {
    let size = std::fs::metadata(path).ok().map(|m| m.len());
    let tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {e}"))?
        .options(
            lofty::config::ParseOptions::new()
                .read_tags(false)
                .read_cover_art(false),
        )
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;
    Ok(from_properties(
        &tagged.file_type(),
        tagged.properties(),
        size,
    ))
}

/// iTunes XML の `Kind` ("MPEG audio file" / "Apple Lossless audio file" 等) から
/// コーデック表示名を推定する。ローカライズされた Kind もあるので、判別できない場合は None。
pub fn codec_from_itunes_kind(kind: &str) -> Option<String> {
    let k = kind.to_ascii_lowercase();
    let label = if k.contains("lossless") || k.contains("alac") {
        "ALAC"
    } else if k.contains("aac") {
        "AAC"
    } else if k.contains("mpeg") || k.contains("mp3") {
        "MP3"
    } else if k.contains("flac") {
        "FLAC"
    } else if k.contains("wav") {
        "WAV"
    } else if k.contains("aiff") {
        "AIFF"
    } else {
        return None;
    };
    Some(label.to_string())
}

/// エクスポート用に、コーデック表示名から iTunes XML の `Kind` 文字列を作る。
pub fn itunes_kind_for_codec(codec: &str) -> Option<&'static str> {
    match codec {
        "MP3" => Some("MPEG audio file"),
        "AAC" => Some("AAC audio file"),
        "ALAC" => Some("Apple Lossless audio file"),
        "WAV" => Some("WAV audio file"),
        "AIFF" => Some("AIFF audio file"),
        "FLAC" => Some("FLAC audio file"),
        _ => None,
    }
}

/// テスト用: 44.1kHz / 16bit / stereo / 0.1 秒の無音 PCM WAV を書き出し、バイト数を返す。
#[cfg(test)]
pub(crate) fn write_test_wav(path: &Path) -> usize {
    let sample_rate: u32 = 44_100;
    let channels: u16 = 2;
    let bits: u16 = 16;
    let frames: u32 = 4_410;
    let data_len = frames * u32::from(channels) * u32::from(bits / 8);
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * u32::from(channels) * u32::from(bits / 8);
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&(channels * bits / 8).to_le_bytes());
    buf.extend_from_slice(&bits.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());
    buf.resize(buf.len() + data_len as usize, 0);
    std::fs::write(path, &buf).unwrap();
    buf.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp4_codec_depends_on_bit_depth() {
        assert_eq!(codec_label(&FileType::Mp4, None), "AAC");
        assert_eq!(codec_label(&FileType::Mp4, Some(16)), "ALAC");
        assert_eq!(codec_label(&FileType::Mpeg, None), "MP3");
        assert_eq!(codec_label(&FileType::Flac, Some(24)), "FLAC");
    }

    #[test]
    fn itunes_kind_round_trip() {
        for codec in ["MP3", "AAC", "ALAC", "WAV", "AIFF", "FLAC"] {
            let kind = itunes_kind_for_codec(codec).unwrap();
            assert_eq!(codec_from_itunes_kind(kind).as_deref(), Some(codec));
        }
        assert_eq!(
            codec_from_itunes_kind("Purchased AAC audio file").as_deref(),
            Some("AAC")
        );
        assert_eq!(codec_from_itunes_kind("Internet audio stream"), None);
    }

    /// 実ファイル読み取り経路 (lofty probe + fs metadata) を検証する。
    #[test]
    fn reads_wav_properties() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        let len = write_test_wav(&path);

        let meta = read_tech_meta(&path).unwrap();
        assert_eq!(meta.codec.as_deref(), Some("WAV"));
        assert_eq!(meta.sample_rate_hz, Some(44_100));
        assert_eq!(meta.bit_depth, Some(16));
        assert_eq!(meta.channels, Some(2));
        assert_eq!(meta.file_size_bytes, Some(len as i64));
        assert_eq!(meta.bitrate_kbps, Some(1411));
    }

    #[test]
    fn unreadable_file_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("junk.mp3");
        std::fs::write(&path, b"not audio").unwrap();
        assert!(read_tech_meta(&path).is_err());
    }
}
