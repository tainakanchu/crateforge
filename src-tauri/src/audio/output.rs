//! 出力デバイスの列挙と、指定デバイスでの rodio 出力ストリームのオープン (#170)。
//!
//! cpal の `DeviceId` はプラットフォーム / バックエンドによって再起動や抜き差しで
//! 変わりうるため、永続化・選択のキーには表示名 (`DeviceDescription::name`) を使う。
//! 選択値 `None` は「システム既定」(OS の既定出力に追従) を表す。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::stream::MixerDeviceSink;
use rodio::DeviceSinkBuilder;
use serde::Serialize;

/// フロントへ返す出力デバイス 1 件。`name` がそのまま選択・永続化のキー。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputDeviceInfo {
    pub name: String,
    /// OS の既定出力デバイスか。
    pub is_default: bool,
}

/// 保存済みの選択を、いま見えているデバイス一覧に照らして解決した結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceChoice {
    /// システム既定を使う (未選択 / 明示的に「システム既定」)。
    SystemDefault,
    /// 一覧に存在するデバイス。中身は一覧側の正式な名前。
    Named(String),
    /// 保存済みの名前が一覧に無い (抜かれている等)。既定へフォールバックする。
    Missing(String),
}

/// 保存済みデバイス名を一覧と突き合わせる。完全一致を優先し、無ければ前後空白と
/// 大文字小文字を無視して比較する (OS 更新でケースが変わる程度の揺れは吸収する)。
/// 空文字 / 空白のみは「システム既定」扱い。
pub fn resolve_choice(saved: Option<&str>, available: &[String]) -> DeviceChoice {
    let Some(saved) = saved.map(str::trim).filter(|s| !s.is_empty()) else {
        return DeviceChoice::SystemDefault;
    };
    if let Some(hit) = available.iter().find(|n| n.as_str() == saved) {
        return DeviceChoice::Named(hit.clone());
    }
    let folded = saved.to_lowercase();
    if let Some(hit) = available.iter().find(|n| n.trim().to_lowercase() == folded) {
        return DeviceChoice::Named(hit.clone());
    }
    DeviceChoice::Missing(saved.to_string())
}

/// 名前一覧を重複除去しつつ順序を保って `OutputDeviceInfo` にする。
/// 同名デバイスが複数ある場合は先頭のみ (名前で選ぶので区別できないため)。
pub fn build_device_list(names: Vec<String>, default_name: Option<&str>) -> Vec<OutputDeviceInfo> {
    let mut out: Vec<OutputDeviceInfo> = Vec::new();
    for name in names {
        let name = name.trim().to_string();
        if name.is_empty() || out.iter().any(|d| d.name == name) {
            continue;
        }
        let is_default = default_name.is_some_and(|d| d.trim() == name);
        out.push(OutputDeviceInfo { name, is_default });
    }
    out
}

fn device_name(d: &rodio::cpal::Device) -> Option<String> {
    d.description().ok().map(|desc| desc.name().to_string())
}

/// cpal の既定ホストで出力デバイスを列挙する。デバイスが無い / 列挙に失敗した
/// 場合は空を返す (エラーにはしない)。
pub fn list_output_devices() -> Vec<OutputDeviceInfo> {
    let host = rodio::cpal::default_host();
    let default_name = host.default_output_device().as_ref().and_then(device_name);
    let names: Vec<String> = match host.output_devices() {
        Ok(devs) => devs.filter_map(|d| device_name(&d)).collect(),
        Err(e) => {
            crate::logging::write_line("warn", &format!("output devices: {}", e));
            Vec::new()
        }
    };
    build_device_list(names, default_name.as_deref())
}

/// OS 既定の出力デバイス名 (無ければ None)。
pub fn list_default_name() -> Option<String> {
    rodio::cpal::default_host()
        .default_output_device()
        .as_ref()
        .and_then(device_name)
}

fn find_device(name: &str) -> Option<rodio::cpal::Device> {
    let host = rodio::cpal::default_host();
    let devs = host.output_devices().ok()?;
    let mut fallback = None;
    let folded = name.trim().to_lowercase();
    for d in devs {
        let Some(n) = device_name(&d) else { continue };
        if n == name {
            return Some(d);
        }
        if fallback.is_none() && n.trim().to_lowercase() == folded {
            fallback = Some(d);
        }
    }
    fallback
}

/// 開いた出力ストリームと、その「デバイス喪失」フラグ。
pub struct OpenedSink {
    pub sink: MixerDeviceSink,
    /// 実際に開いたデバイスの名前 (取れなければ None)。
    pub name: Option<String>,
    /// cpal のエラーコールバックが `DeviceNotAvailable` / `StreamInvalidated` を
    /// 受けたら立つ。ストリームごとに別の Arc なので、差し替え後の古いストリームの
    /// エラーで新しいストリームを誤って開き直すことはない。
    pub lost: Arc<AtomicBool>,
}

fn error_callback(lost: Arc<AtomicBool>) -> impl FnMut(rodio::cpal::StreamError) + Send + Clone {
    move |err: rodio::cpal::StreamError| {
        use rodio::cpal::StreamError;
        // アンダーラン等は一時的なグリッチなので開き直さない。
        let fatal = matches!(
            err,
            StreamError::DeviceNotAvailable | StreamError::StreamInvalidated
        );
        if fatal && !lost.swap(true, Ordering::Relaxed) {
            crate::logging::write_line("warn", &format!("audio output lost: {}", err));
        }
    }
}

fn open_device(device: rodio::cpal::Device) -> Result<OpenedSink, String> {
    let name = device_name(&device);
    let lost = Arc::new(AtomicBool::new(false));
    let builder = DeviceSinkBuilder::from_device(device).map_err(|e| e.to_string())?;
    let mut sink = builder
        .with_error_callback(error_callback(lost.clone()))
        .open_sink_or_fallback()
        .map_err(|e| e.to_string())?;
    // drop 時に stderr へ "Dropping DeviceSink..." を吐くのを抑止する。
    sink.log_on_drop(false);
    Ok(OpenedSink { sink, name, lost })
}

/// システム既定の出力を開く。既定デバイスで開けなければ rodio と同様に
/// 他のデバイスを順に試す (その場合は喪失検知のコールバックは付かない)。
pub fn open_default() -> Result<OpenedSink, String> {
    let host = rodio::cpal::default_host();
    if let Some(dev) = host.default_output_device() {
        if let Ok(opened) = open_device(dev) {
            return Ok(opened);
        }
    }
    let mut sink = DeviceSinkBuilder::open_default_sink().map_err(|e| e.to_string())?;
    sink.log_on_drop(false);
    Ok(OpenedSink {
        sink,
        name: None,
        lost: Arc::new(AtomicBool::new(false)),
    })
}

/// 名前で指定したデバイスを開く。見つからなければ Err。
pub fn open_named(name: &str) -> Result<OpenedSink, String> {
    let dev = find_device(name).ok_or_else(|| format!("Output device not found: {}", name))?;
    open_device(dev)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_or_none_is_system_default() {
        let avail = names(&["Speakers", "Booth"]);
        assert_eq!(resolve_choice(None, &avail), DeviceChoice::SystemDefault);
        assert_eq!(
            resolve_choice(Some(""), &avail),
            DeviceChoice::SystemDefault
        );
        assert_eq!(
            resolve_choice(Some("  "), &avail),
            DeviceChoice::SystemDefault
        );
    }

    #[test]
    fn exact_match_wins_over_case_insensitive() {
        let avail = names(&["booth", "Booth"]);
        assert_eq!(
            resolve_choice(Some("Booth"), &avail),
            DeviceChoice::Named("Booth".into())
        );
    }

    #[test]
    fn case_and_whitespace_differences_are_tolerated() {
        let avail = names(&["Speakers", "USB Audio CODEC "]);
        assert_eq!(
            resolve_choice(Some("usb audio codec"), &avail),
            DeviceChoice::Named("USB Audio CODEC ".into())
        );
    }

    #[test]
    fn missing_device_falls_back() {
        let avail = names(&["Speakers"]);
        assert_eq!(
            resolve_choice(Some("Booth"), &avail),
            DeviceChoice::Missing("Booth".into())
        );
        // デバイスが 1 つも無い環境でも panic せず Missing。
        assert_eq!(
            resolve_choice(Some("Booth"), &[]),
            DeviceChoice::Missing("Booth".into())
        );
    }

    #[test]
    fn device_list_dedupes_and_marks_default() {
        let list = build_device_list(
            names(&["Speakers", "Booth", "Speakers", " ", "HDMI"]),
            Some("Booth"),
        );
        assert_eq!(
            list,
            vec![
                OutputDeviceInfo {
                    name: "Speakers".into(),
                    is_default: false
                },
                OutputDeviceInfo {
                    name: "Booth".into(),
                    is_default: true
                },
                OutputDeviceInfo {
                    name: "HDMI".into(),
                    is_default: false
                },
            ]
        );
        assert!(build_device_list(Vec::new(), None).is_empty());
    }

    /// 実機に依存するが、デバイスが 0 個の環境 (CI / コンテナ) でも panic せず、
    /// 存在しない名前は Err になることだけを確かめる。
    #[test]
    fn enumeration_tolerates_missing_hardware() {
        let list = list_output_devices();
        assert!(list.iter().filter(|d| d.is_default).count() <= 1);
        assert!(open_named("crateforge-nonexistent-device-170").is_err());
    }
}
