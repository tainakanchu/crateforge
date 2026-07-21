//! 変換用 ffmpeg の解決とオンデマンド取得。
//!
//! 解決順:
//!   1. アプリのキャッシュ  (`<app_local_data>/bin/ffmpeg[.exe]`)  ← 自動DLの保存先
//!   2. 旧バンドル resource (`<resource_dir>/ffmpeg.exe`)          ← 旧インストール互換
//!   3. PATH 上の `ffmpeg`
//! いずれも無ければ Windows のみ BtbN の win64 GPL ビルドを取得してキャッシュへ置く。
//!
//! ライセンス: ffmpeg は CLI 経由で別プロセス起動しているだけ（リンクしていない）なので
//! 本体のライセンスには影響しない。自動DLはユーザーが上流(BtbN)から取得する形であり、
//! こちらで再配布していないため GPL の再配布義務は発生しない。

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};
// `Emitter::emit` は自動DL（Windows）でのみ使う。
#[cfg(target_os = "windows")]
use tauri::Emitter;

#[cfg(target_os = "windows")]
pub const EXE: &str = "ffmpeg.exe";
#[cfg(not(target_os = "windows"))]
pub const EXE: &str = "ffmpeg";

/// BtbN の最新 win64 GPL ビルド（zip 内に `.../bin/ffmpeg.exe`）。
#[cfg(target_os = "windows")]
const DOWNLOAD_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

/// 設定画面向けの ffmpeg の状態。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub available: bool,
    pub path: Option<String>,
    /// "cache" | "bundled" | "path" | "none"
    pub source: String,
    /// 自動DLに対応しているか（Windows のみ）。
    pub can_download: bool,
}

/// `ffmpeg-progress` イベントのペイロード（自動DLは Windows のみ）。
#[cfg(target_os = "windows")]
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FfmpegProgress {
    Start,
    Download { received: u64, total: u64 },
    Extract,
    Done,
    Error { message: String },
}

/// Windows でコンソール窓を出さずに子プロセスを起動する。
#[cfg(target_os = "windows")]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn no_window(_cmd: &mut Command) {}

/// 自動DLの保存先 `<app_local_data>/bin/ffmpeg[.exe]`。
fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("bin").join(EXE))
}

/// 旧バージョンがインストール先へ展開した resource の ffmpeg.exe。
#[cfg(target_os = "windows")]
fn bundled_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|d| d.join("ffmpeg.exe"))
        .filter(|p| p.exists())
}

/// PATH 上に `ffmpeg` があるか軽く検査する。
fn path_has_ffmpeg() -> bool {
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-version");
    no_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// 使用する ffmpeg を解決する（取得元の種別も返す）。
pub fn resolve(app: &AppHandle) -> Option<(PathBuf, &'static str)> {
    if let Some(p) = cache_path(app) {
        if p.exists() {
            return Some((p, "cache"));
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(p) = bundled_path(app) {
        return Some((p, "bundled"));
    }
    if path_has_ffmpeg() {
        return Some((PathBuf::from("ffmpeg"), "path"));
    }
    None
}

/// 設定画面向けに現在の状態を返す。
pub fn status(app: &AppHandle) -> FfmpegStatus {
    let can_download = cfg!(target_os = "windows");
    match resolve(app) {
        Some((p, src)) => FfmpegStatus {
            available: true,
            path: Some(p.display().to_string()),
            source: src.to_string(),
            can_download,
        },
        None => FfmpegStatus {
            available: false,
            path: None,
            source: "none".to_string(),
            can_download,
        },
    }
}

/// ffmpeg を解決し、見つからなければ（Windows のみ）取得してから返す。
pub async fn ensure(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some((p, _)) = resolve(app) {
        return Ok(p);
    }
    #[cfg(target_os = "windows")]
    {
        return download(app).await;
    }
    #[allow(unreachable_code)]
    Err("ffmpeg が見つかりません。PATH に ffmpeg を入れてください。".to_string())
}

/// BtbN から ffmpeg(GPL) を取得し、キャッシュへ展開する。進捗は `ffmpeg-progress` で配信。
#[cfg(target_os = "windows")]
pub async fn download(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = cache_path(app).ok_or("キャッシュ先を解決できませんでした")?;
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("フォルダ作成に失敗: {e}"))?;
    }

    let _ = app.emit("ffmpeg-progress", FfmpegProgress::Start);

    let run = async {
        let client = reqwest::Client::builder()
            .user_agent("Crateforge")
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client
            .get(DOWNLOAD_URL)
            .send()
            .await
            .map_err(|e| format!("ダウンロード開始に失敗: {e}"))?
            .error_for_status()
            .map_err(|e| format!("ダウンロードに失敗: {e}"))?;

        let total = resp.content_length().unwrap_or(0);
        let mut received: u64 = 0;
        let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("ダウンロード中にエラー: {e}"))?
        {
            bytes.extend_from_slice(&chunk);
            received += chunk.len() as u64;
            let _ = app.emit(
                "ffmpeg-progress",
                FfmpegProgress::Download { received, total },
            );
        }

        let _ = app.emit("ffmpeg-progress", FfmpegProgress::Extract);
        extract_ffmpeg(&bytes, &dest)?;
        Ok::<PathBuf, String>(dest.clone())
    };

    match run.await {
        Ok(p) => {
            let _ = app.emit("ffmpeg-progress", FfmpegProgress::Done);
            Ok(p)
        }
        Err(e) => {
            let _ = app.emit(
                "ffmpeg-progress",
                FfmpegProgress::Error { message: e.clone() },
            );
            Err(e)
        }
    }
}

/// zip から `.../bin/ffmpeg.exe` だけを取り出して `dest` に書き出す。
#[cfg(target_os = "windows")]
fn extract_ffmpeg(zip_bytes: &[u8], dest: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Write};
    let reader = std::io::Cursor::new(zip_bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("zip を開けません: {e}"))?;

    let mut target: Option<usize> = None;
    for i in 0..zip.len() {
        let name = {
            let f = zip.by_index(i).map_err(|e| e.to_string())?;
            f.name().replace('\\', "/")
        };
        if name.ends_with("bin/ffmpeg.exe") {
            target = Some(i);
            break;
        }
    }
    let idx = target.ok_or("アーカイブ内に ffmpeg.exe が見つかりません")?;

    let mut file = zip.by_index(idx).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    // 途中失敗で壊れたファイルを残さないよう、一旦 .part に書いてから rename。
    let tmp = dest.with_extension("part");
    {
        let mut out = std::fs::File::create(&tmp).map_err(|e| format!("書き込みに失敗: {e}"))?;
        out.write_all(&buf)
            .map_err(|e| format!("書き込みに失敗: {e}"))?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("保存に失敗: {e}"))?;
    Ok(())
}
