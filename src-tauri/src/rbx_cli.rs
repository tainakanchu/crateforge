//! USB 書き出しエンジン rbx-cli の解決・互換性確認・オンデマンド取得。
//!
//! ライセンス: rbx-cli (<https://github.com/tainakanchu/rbx-cli>) は GPL-2.0-or-later
//! (配布バイナリは LGPL-3.0 の mp3lame-encoder を含むため実質 GPL-3.0) の **独立した CLI** で、
//! crateforge はそれを ffmpeg と同じく **別プロセスとして起動し、stdin/stdout の JSON
//! (NDJSON) で対話するだけ** である。rbx-cli / rbxport のコードはリンクも複製もしておらず、
//! リクエスト / 結果の型も公開プロトコル文書から crateforge 側で独自に書き起こしている
//! (`crate::usb_export::wire`)。バイナリは配布物に同梱せず、ユーザーの操作で上流の GitHub
//! Release から取得してユーザーのローカル領域に置く (mere aggregation)。よって MIT の本体に
//! GPL の義務は及ばない (`crate::ffmpeg` と同じ考え方)。
//!
//! 解決順:
//!   1. ユーザー指定のパス (`app_state` の [`OVERRIDE_STATE_KEY`])  ← 指定時はこれだけを使う
//!   2. アプリのキャッシュ `<app_local_data>/bin/rbx-cli/<version>/rbx-cli[.exe]`  ← 自動DL先
//!   3. (開発ビルドのみ) PATH 上の `rbx-cli`。リリースビルドでは、検証していない PATH 上の
//!      実行ファイルを勝手に起動しない (使うなら 1. で明示的に指定する)。
//!
//! どれを使う場合も `rbx-cli --json version` で protocol と必要な capability を確認し、
//! 合わなければ使わずに分かりやすいエラーを返す。
//!
//! 取得 ([`download`]): 保存先フォルダのロックファイルを新規作成で取り (他のインスタンスと
//! 同時に取得しない)、固定バージョン [`RBX_CLI_VERSION`] の Release アセットを保存先フォルダ内の
//! 一意な一時ファイルへストリーミング保存しながら SHA-256 を計算 → ソースに固定した
//! [`PINNED_SHA256`] と照合 (固定値が無いアセットに限り Release の `SHA256SUMS`) → **ハッシュを
//! 計算したのと同じファイルハンドル** から展開 (Windows は zip、他は tar.gz) → 実行権限 →
//! アトミック rename。失敗時は一時ファイルを残さない。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::usb_export::wire::{self, Envelope, ErrorLine, VersionInfo};

/// crateforge が取得・想定する rbx-cli のバージョン。
pub const RBX_CLI_VERSION: &str = "0.1.1";

/// rbx-cli の GitHub Release のダウンロード元。
const RELEASE_BASE: &str = "https://github.com/tainakanchu/rbx-cli/releases/download";

/// ユーザーが指定した rbx-cli のパスを保存する `app_state` のキー。
pub const OVERRIDE_STATE_KEY: &str = "rbx_cli_path";

/// アセットごとの SHA-256 をソースに固定した表 (`(アセット名, 小文字 hex)`)。
///
/// ダウンロードはこの値だけで検証し、同じ Release の `SHA256SUMS` は取りに行かない
/// (同じ配布元のファイルなので、ソースに固定した値と突き合わせる以上の意味が無い)。
/// [`RBX_CLI_VERSION`] を上げるときはここも必ず更新する (全ターゲット分あることをテストで確認)。
/// 該当アセットが無い場合に限り `SHA256SUMS` にフォールバックする (転送破損の検知が主)。
pub const PINNED_SHA256: &[(&str, &str)] = &[
    (
        "rbx-cli-0.1.1-aarch64-apple-darwin.tar.gz",
        "3ef7044388e889a59c1f928405deba8ed6887a3604b8d2b26d3fee84512bfc94",
    ),
    (
        "rbx-cli-0.1.1-x86_64-apple-darwin.tar.gz",
        "fb9642d726e6983130f92eef276a474ddc1d35a994bf640ac082d4058686ffee",
    ),
    (
        "rbx-cli-0.1.1-x86_64-pc-windows-msvc.zip",
        "e8cdb2d24b1a9b384985de82d82b0eb6716d5edc6364e2a1479d4b1d85ec6c94",
    ),
    (
        "rbx-cli-0.1.1-x86_64-unknown-linux-gnu.tar.gz",
        "e07f1bce889325fc3b226eec26cab8abfb5e7f7ae43a4f2459c1523490c1d415",
    ),
];

/// Release のビルドマトリクス (rbx-cli の release.yml) のターゲット。
#[cfg_attr(not(test), allow(dead_code))]
const RELEASE_TARGETS: &[&str] = &[
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
];

/// crateforge が必要とする capability (rbx-cli `version` が返す安定文字列)。
/// 0.1.1 で追加されたもの (競合の理由・CDJ の変更の保持・stdin の終端での中止) も必須にする
/// ので、指定パスの古い rbx-cli (0.1.0) は「更新してください」で弾かれる。
const REQUIRED_CAPABILITIES: &[&str] = &[
    "usb.export",
    "usb.export.dryRun",
    "usb.export.cues",
    "usb.export.beatGrid.anchors",
    "usb.export.stdinCancel",
    "usb.export.stdinEofCancel",
    "usb.export.conflictReasons",
    "usb.export.keepDeviceChanges",
    "devices.list",
    "devices.eject",
];

#[cfg(target_os = "windows")]
pub const EXE: &str = "rbx-cli.exe";
#[cfg(not(target_os = "windows"))]
pub const EXE: &str = "rbx-cli";

/// `version --json` 等の短いコマンドの制限時間。
const SHORT_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// `devices eject` の制限時間 (書き込みキャッシュの吐き出しで時間がかかることがある)。
pub const EJECT_TIMEOUT: Duration = Duration::from_secs(120);
/// ダウンロードのロックファイル名 (保存先フォルダ内)。
const DOWNLOAD_LOCK: &str = ".download.lock";
/// これより古いロックファイルは、異常終了したインスタンスの残骸とみなして取り直す。
const STALE_LOCK: Duration = Duration::from_secs(15 * 60);

/// 同時に 1 つだけダウンロードする。
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// このビルドのターゲットに対応する Release のターゲット名 (release.yml のマトリクス)。
pub fn target_triple() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("x86_64-apple-darwin")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("x86_64-pc-windows-msvc")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("x86_64-unknown-linux-gnu")
    } else {
        None
    }
}

/// Release のアセット名 `rbx-cli-<version>-<target>.tar.gz` (Windows は `.zip`)。
pub fn asset_name(version: &str, target: &str) -> String {
    let ext = if target.contains("windows") {
        "zip"
    } else {
        "tar.gz"
    };
    format!("rbx-cli-{version}-{target}.{ext}")
}

fn release_url(version: &str, file: &str) -> String {
    format!("{RELEASE_BASE}/v{version}/{file}")
}

/// `SHA256SUMS` (`sha256sum` の出力形式) から `asset` の hex を取り出す。
pub fn parse_sha256sums(text: &str, asset: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == asset && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

fn pinned_sha256(asset: &str) -> Option<String> {
    PINNED_SHA256
        .iter()
        .find(|(name, _)| *name == asset)
        .map(|(_, h)| h.to_ascii_lowercase())
}

/// `version` の結果が crateforge と互換か。非互換なら利用者向けの理由を返す。
pub fn check_compatible(info: &VersionInfo) -> Result<(), String> {
    if info.protocol != wire::PROTOCOL_VERSION {
        return Err(format!(
            "rbx-cli {} はプロトコル {} を話しますが、このバージョンの Crateforge はプロトコル {} の rbx-cli が必要です。{}",
            info.version,
            info.protocol,
            wire::PROTOCOL_VERSION,
            if info.protocol > wire::PROTOCOL_VERSION {
                "Crateforge を更新してください。"
            } else {
                "rbx-cli を更新（再ダウンロード）してください。"
            }
        ));
    }
    let missing: Vec<&str> = REQUIRED_CAPABILITIES
        .iter()
        .copied()
        .filter(|c| !info.capabilities.iter().any(|have| have == c))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "rbx-cli {} に必要な機能がありません ({})。rbx-cli を更新してください。",
            info.version,
            missing.join(", ")
        ));
    }
    Ok(())
}

/// 子プロセスの雛形: コンソール窓を出さず、ハンドルが落ちたら必ず kill する。
pub fn command(exe: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::proc::no_window_tokio(&mut cmd);
    cmd
}

/// 短い `--json` コマンドの失敗。
#[derive(Debug, Clone)]
pub enum RunError {
    /// 起動できない / 時間切れ / 出力が読めない。
    Spawn(String),
    /// rbx-cli が `error` 行を返した。
    Cli(ErrorLine),
}

impl RunError {
    pub fn message(&self) -> String {
        match self {
            RunError::Spawn(m) => m.clone(),
            RunError::Cli(e) => crate::usb_export::errors::user_message(e),
        }
    }
}

/// `rbx-cli --json <args>` を実行し、終端の `result` の `data` を返す。
pub async fn run_json(exe: &Path, args: &[&str]) -> Result<serde_json::Value, RunError> {
    run_json_with_timeout(exe, args, SHORT_COMMAND_TIMEOUT).await
}

/// [`run_json`] の制限時間を指定する版。
pub async fn run_json_with_timeout(
    exe: &Path,
    args: &[&str],
    limit: Duration,
) -> Result<serde_json::Value, RunError> {
    let mut cmd = command(exe);
    cmd.arg("--json").args(args);
    let run = async {
        let mut child = cmd.spawn().map_err(|e| {
            RunError::Spawn(format!("rbx-cli を起動できません ({}): {e}", exe.display()))
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RunError::Spawn("stdout を取得できません".into()))?;
        let stderr = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut text = String::new();
            if let Some(err) = stderr {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if text.len() < 4000 {
                        text.push_str(&l);
                        text.push('\n');
                    }
                }
            }
            text
        });
        let mut lines = BufReader::new(stdout).lines();
        let mut terminal: Option<Result<serde_json::Value, RunError>> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            match wire::parse_line(&line) {
                Some(Envelope::Result(data)) => terminal = Some(Ok(data)),
                Some(Envelope::Error(e)) => terminal = Some(Err(RunError::Cli(e))),
                _ => {}
            }
        }
        let status = child
            .wait()
            .await
            .map_err(|e| RunError::Spawn(format!("rbx-cli の終了待ちに失敗: {e}")))?;
        let stderr_text = stderr_task.await.unwrap_or_default();
        match terminal {
            Some(t) => t,
            None => Err(RunError::Spawn(format!(
                "rbx-cli が結果を返さずに終了しました (exit {}){}",
                status.code().map_or("?".to_string(), |c| c.to_string()),
                if stderr_text.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", stderr_text.trim())
                }
            ))),
        }
    };
    match tokio::time::timeout(limit, run).await {
        Ok(r) => r,
        Err(_) => Err(RunError::Spawn("rbx-cli が応答しません (時間切れ)".into())),
    }
}

/// `rbx-cli --json version` を実行してバージョン情報を得る。
pub async fn probe(exe: &Path) -> Result<VersionInfo, String> {
    let data = run_json(exe, &["version"]).await.map_err(|e| e.message())?;
    serde_json::from_value(data).map_err(|e| format!("rbx-cli の version 出力を読めません: {e}"))
}

/// 自動DLの保存先 `<app_local_data>/bin/rbx-cli/<version>/rbx-cli[.exe]`。
pub fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| {
        d.join("bin")
            .join("rbx-cli")
            .join(RBX_CLI_VERSION)
            .join(EXE)
    })
}

/// ユーザー指定のパス (未設定なら None)。
pub fn override_path(app: &AppHandle) -> Option<PathBuf> {
    let db = crate::commands::library::open_db(app).ok()?;
    db.get_state(OVERRIDE_STATE_KEY)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// ユーザー指定のパスを保存 / 解除する。
pub fn set_override_path(app: &AppHandle, path: Option<&str>) -> Result<(), String> {
    let db = crate::commands::library::open_db(app)?;
    db.set_state(OVERRIDE_STATE_KEY, path.map(str::trim).unwrap_or(""))
        .map_err(|e| e.to_string())
}

/// 設定画面・書き出しダイアログ向けの状態。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RbxCliStatus {
    /// 互換性のある rbx-cli が使える状態か。
    pub available: bool,
    /// 使う (使おうとした) バイナリのパス。
    pub path: Option<String>,
    /// "override" | "cache" | "path" | "none"
    pub source: String,
    /// 見つかった rbx-cli のバージョン / プロトコル。
    pub version: Option<String>,
    pub protocol: Option<u32>,
    pub rbxport_rev: Option<String>,
    /// 見つからない・非互換などの理由 (利用者向け)。
    pub error: Option<String>,
    /// ユーザー指定のパス (設定されていれば)。
    pub override_path: Option<String>,
    /// crateforge が取得するバージョン。
    pub pinned_version: String,
    /// この OS 向けのリリースアセットがあるか (= 自動取得できるか)。
    pub can_download: bool,
}

/// 解決結果。
pub struct Resolved {
    pub path: PathBuf,
    pub source: &'static str,
    pub info: VersionInfo,
}

/// 互換性のある rbx-cli を解決する。失敗時は最も参考になる理由を返す。
pub async fn resolve(app: &AppHandle) -> Result<Resolved, (Option<PathBuf>, &'static str, String)> {
    if let Some(p) = override_path(app) {
        if !p.is_file() {
            return Err((
                Some(p.clone()),
                "override",
                format!("設定で指定した rbx-cli が見つかりません: {}", p.display()),
            ));
        }
        return match probe(&p)
            .await
            .and_then(|info| check_compatible(&info).map(|_| info))
        {
            Ok(info) => Ok(Resolved {
                path: p,
                source: "override",
                info,
            }),
            Err(e) => Err((Some(p), "override", e)),
        };
    }
    let mut last_err: Option<(Option<PathBuf>, &'static str, String)> = None;
    if let Some(p) = cache_path(app).filter(|p| p.is_file()) {
        match probe(&p)
            .await
            .and_then(|info| check_compatible(&info).map(|_| info))
        {
            Ok(info) => {
                return Ok(Resolved {
                    path: p,
                    source: "cache",
                    info,
                })
            }
            Err(e) => last_err = Some((Some(p), "cache", e)),
        }
    }
    // PATH 上の rbx-cli は開発ビルドだけ (リリースでは検証していない実行ファイルを起動しない)。
    #[cfg(debug_assertions)]
    {
        let on_path = PathBuf::from(EXE);
        // PATH に無いのは普通なので、起動できないことは理由にしない。
        if let Ok(info) = probe(&on_path).await {
            match check_compatible(&info) {
                Ok(()) => {
                    return Ok(Resolved {
                        path: on_path,
                        source: "path",
                        info,
                    })
                }
                Err(e) => last_err = last_err.or(Some((Some(on_path), "path", e))),
            }
        }
    }
    Err(last_err.unwrap_or((
        None,
        "none",
        "rbx-cli が見つかりません。USB 書き出しには rbx-cli（GPL の外部ツール）が必要です。ダウンロードしてください。"
            .to_string(),
    )))
}

pub async fn status(app: &AppHandle) -> RbxCliStatus {
    let override_path = override_path(app).map(|p| p.display().to_string());
    let can_download = target_triple().is_some();
    match resolve(app).await {
        Ok(r) => RbxCliStatus {
            available: true,
            path: Some(r.path.display().to_string()),
            source: r.source.to_string(),
            version: Some(r.info.version),
            protocol: Some(r.info.protocol),
            rbxport_rev: Some(r.info.rbxport_rev).filter(|s| !s.is_empty()),
            error: None,
            override_path,
            pinned_version: RBX_CLI_VERSION.to_string(),
            can_download,
        },
        Err((path, source, error)) => RbxCliStatus {
            available: false,
            path: path.map(|p| p.display().to_string()),
            source: source.to_string(),
            version: None,
            protocol: None,
            rbxport_rev: None,
            error: Some(error),
            override_path,
            pinned_version: RBX_CLI_VERSION.to_string(),
            can_download,
        },
    }
}

/// 使える rbx-cli のパスを返す (無ければ利用者向けエラー)。
pub async fn ensure(app: &AppHandle) -> Result<PathBuf, String> {
    resolve(app).await.map(|r| r.path).map_err(|(_, _, e)| e)
}

// ============================================================ download

/// `rbx-cli-progress` イベントのペイロード。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RbxCliProgress {
    Start { version: String },
    Download { received: u64, total: u64 },
    Verify,
    Extract,
    Done { path: String },
    Error { message: String },
}

struct DownloadGuard;
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

/// rbx-cli を GitHub Release から取得してキャッシュへ置き、互換性を確認して返す。
/// 進捗は `rbx-cli-progress` で配信する。
pub async fn download(app: &AppHandle) -> Result<PathBuf, String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("rbx-cli のダウンロードは既に実行中です".to_string());
    }
    let _guard = DownloadGuard;
    let _ = app.emit(
        "rbx-cli-progress",
        RbxCliProgress::Start {
            version: RBX_CLI_VERSION.to_string(),
        },
    );
    match download_inner(app).await {
        Ok(p) => {
            let _ = app.emit(
                "rbx-cli-progress",
                RbxCliProgress::Done {
                    path: p.display().to_string(),
                },
            );
            Ok(p)
        }
        Err(e) => {
            let _ = app.emit(
                "rbx-cli-progress",
                RbxCliProgress::Error { message: e.clone() },
            );
            Err(e)
        }
    }
}

async fn download_inner(app: &AppHandle) -> Result<PathBuf, String> {
    let target = target_triple()
        .ok_or("この OS / CPU 向けの rbx-cli は配布されていません。rbx-cli をビルドして設定でパスを指定してください。")?;
    let dest = cache_path(app).ok_or("保存先フォルダを解決できませんでした")?;
    let emit = |p: RbxCliProgress| {
        let _ = app.emit("rbx-cli-progress", p);
    };
    let client = reqwest::Client::builder()
        .user_agent("Crateforge")
        .build()
        .map_err(|e| e.to_string())?;
    download_to(&client, target, &dest, None, &emit).await?;
    Ok(dest)
}

/// `target` 向けの Release アセットを取得して `dest` に実行ファイルを置き、互換性を確認する。
/// `expected_sha256` を渡すとそれで検証する (テスト用。通常は None = 固定値 / SHA256SUMS)。
pub async fn download_to(
    client: &reqwest::Client,
    target: &str,
    dest: &Path,
    expected_sha256: Option<String>,
    progress: &(dyn Fn(RbxCliProgress) + Sync),
) -> Result<VersionInfo, String> {
    use sha2::{Digest, Sha256};

    let dir = dest
        .parent()
        .ok_or("保存先フォルダを解決できませんでした")?
        .to_path_buf();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("フォルダ作成に失敗: {e}"))?;

    let asset = asset_name(RBX_CLI_VERSION, target);

    // 期待するハッシュ: ソースに固定した値 → 無ければ同 Release の SHA256SUMS。
    let expected = match expected_sha256.or_else(|| pinned_sha256(&asset)) {
        Some(h) => h,
        None => {
            let sums = client
                .get(release_url(RBX_CLI_VERSION, "SHA256SUMS"))
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("チェックサム (SHA256SUMS) の取得に失敗: {e}"))?
                .text()
                .await
                .map_err(|e| format!("チェックサム (SHA256SUMS) の取得に失敗: {e}"))?;
            parse_sha256sums(&sums, &asset)
                .ok_or_else(|| format!("SHA256SUMS に {asset} がありません"))?
        }
    };

    // 同じ保存先へ同時に取得しない (別インスタンスを含む)。
    let _lock = DownloadLock::acquire(&dir)?;

    // 本体を保存先フォルダ内の一意な一時ファイルへストリーミング保存しつつハッシュを計算する
    // (全体をメモリに載せない)。一時ファイルは落ちると消えるので、どの失敗でも残らない。
    let archive = tempfile::Builder::new()
        .prefix(".rbx-cli-download-")
        .suffix(".part")
        .tempfile_in(&dir)
        .map_err(|e| format!("書き込みに失敗: {e}"))?;
    let mut resp = client
        .get(release_url(RBX_CLI_VERSION, &asset))
        .send()
        .await
        .map_err(|e| format!("ダウンロード開始に失敗: {e}"))?
        .error_for_status()
        .map_err(|e| format!("ダウンロードに失敗: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut received: u64 = 0;
    let mut hasher = Sha256::new();
    {
        let handle = archive
            .as_file()
            .try_clone()
            .map_err(|e| format!("書き込みに失敗: {e}"))?;
        let mut out = tokio::fs::File::from_std(handle);
        let mut last_emit = 0u64;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("ダウンロード中にエラー: {e}"))?
        {
            hasher.update(&chunk);
            out.write_all(&chunk)
                .await
                .map_err(|e| format!("書き込みに失敗: {e}"))?;
            received += chunk.len() as u64;
            // イベントを撒きすぎないよう 256KB ごとに通知する。
            if received - last_emit >= 256 * 1024 || received == total {
                last_emit = received;
                progress(RbxCliProgress::Download { received, total });
            }
        }
        out.flush()
            .await
            .map_err(|e| format!("書き込みに失敗: {e}"))?;
    }

    progress(RbxCliProgress::Verify);
    let actual = hex(&hasher.finalize());
    if actual != expected {
        return Err(format!(
            "ダウンロードした rbx-cli のチェックサムが一致しません (期待 {expected}, 実際 {actual})。もう一度お試しください。"
        ));
    }

    progress(RbxCliProgress::Extract);
    let dest_clone = dest.to_path_buf();
    // 名前で開き直さず、ハッシュを計算したのと同じファイル (ハンドル) から展開する。
    tokio::task::spawn_blocking(move || {
        let mut file = archive
            .as_file()
            .try_clone()
            .map_err(|e| format!("アーカイブを開けません: {e}"))?;
        use std::io::Seek;
        file.rewind()
            .map_err(|e| format!("アーカイブを開けません: {e}"))?;
        let result = extract_binary_from(file, &dest_clone);
        drop(archive); // 一時ファイルを消す
        result
    })
    .await
    .map_err(|e| format!("展開に失敗: {e}"))??;

    // 取得したものが本当に使えるか確かめる。
    let info = probe(dest).await?;
    check_compatible(&info)?;
    Ok(info)
}

/// 保存先フォルダのロックファイル (新規作成で取る)。落ちると消す。
struct DownloadLock {
    path: PathBuf,
}

impl DownloadLock {
    fn acquire(dir: &Path) -> Result<Self, String> {
        let path = dir.join(DOWNLOAD_LOCK);
        for attempt in 0..2 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut f) => {
                    use std::io::Write;
                    let _ = writeln!(f, "{}", std::process::id());
                    return Ok(Self { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                    // 異常終了したインスタンスの残骸なら取り直す。
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > STALE_LOCK);
                    if !stale {
                        break;
                    }
                    let _ = std::fs::remove_file(&path);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => break,
                Err(e) => return Err(format!("ダウンロードの準備に失敗: {e}")),
            }
        }
        Err(
            "rbx-cli は別の Crateforge で取得中です。終わってから「再チェック」してください。"
                .into(),
        )
    }
}

impl Drop for DownloadLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// アーカイブ (パス) から実行ファイルだけを取り出して `dest` に置く。
#[cfg_attr(not(test), allow(dead_code))]
pub fn extract_binary(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("アーカイブを開けません: {e}"))?;
    extract_binary_from(file, dest)
}

/// 開いたアーカイブから実行ファイルだけを取り出し、同じフォルダの一意な一時ファイル経由の
/// アトミック rename で `dest` に置く。失敗時は何も残さない。
pub fn extract_binary_from(archive: std::fs::File, dest: &Path) -> Result<(), String> {
    let dir = dest
        .parent()
        .ok_or("保存先フォルダを解決できませんでした")?;
    let tmp = tempfile::Builder::new()
        .prefix(".rbx-cli-extract-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(|e| format!("書き込みに失敗: {e}"))?;
    let out = tmp
        .as_file()
        .try_clone()
        .map_err(|e| format!("書き込みに失敗: {e}"))?;
    extract_to(archive, out)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("実行権限の設定に失敗: {e}"))?;
    }
    tmp.persist(dest)
        .map(|_| ())
        .map_err(|e| format!("保存に失敗: {}", e.error))
}

#[cfg(not(target_os = "windows"))]
fn extract_to(archive: std::fs::File, mut out: std::fs::File) -> Result<(), String> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar
        .entries()
        .map_err(|e| format!("アーカイブを読めません: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("アーカイブを読めません: {e}"))?;
        let is_exe = entry.header().entry_type().is_file()
            && entry
                .path()
                .ok()
                .and_then(|p| p.file_name().map(|n| n == EXE))
                .unwrap_or(false);
        if is_exe {
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("書き込みに失敗: {e}"))?;
            use std::io::Write;
            out.flush().map_err(|e| format!("書き込みに失敗: {e}"))?;
            return Ok(());
        }
    }
    Err(format!("アーカイブ内に {EXE} が見つかりません"))
}

#[cfg(target_os = "windows")]
fn extract_to(archive: std::fs::File, mut out: std::fs::File) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(archive).map_err(|e| format!("zip を開けません: {e}"))?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().replace('\\', "/");
        if f.is_file() && name.rsplit('/').next() == Some(EXE) {
            std::io::copy(&mut f, &mut out).map_err(|e| format!("書き込みに失敗: {e}"))?;
            use std::io::Write;
            out.flush().map_err(|e| format!("書き込みに失敗: {e}"))?;
            return Ok(());
        }
    }
    Err(format!("アーカイブ内に {EXE} が見つかりません"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_follow_the_release_workflow() {
        assert_eq!(
            asset_name("0.1.0", "x86_64-unknown-linux-gnu"),
            "rbx-cli-0.1.0-x86_64-unknown-linux-gnu.tar.gz"
        );
        assert_eq!(
            asset_name("0.1.0", "aarch64-apple-darwin"),
            "rbx-cli-0.1.0-aarch64-apple-darwin.tar.gz"
        );
        assert_eq!(
            asset_name("0.1.0", "x86_64-pc-windows-msvc"),
            "rbx-cli-0.1.0-x86_64-pc-windows-msvc.zip"
        );
        assert_eq!(
            release_url("0.1.0", "SHA256SUMS"),
            "https://github.com/tainakanchu/rbx-cli/releases/download/v0.1.0/SHA256SUMS"
        );
        // この CI/開発ターゲット (x86_64 Linux) では取得対象がある。
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert_eq!(target_triple(), Some("x86_64-unknown-linux-gnu"));
    }

    #[test]
    fn sha256sums_lines_are_parsed() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let text = format!(
            "{a}  rbx-cli-0.1.0-x86_64-unknown-linux-gnu.tar.gz\n{b} *rbx-cli-0.1.0-x86_64-pc-windows-msvc.zip\nnot a line\n"
        );
        assert_eq!(
            parse_sha256sums(&text, "rbx-cli-0.1.0-x86_64-unknown-linux-gnu.tar.gz"),
            Some(a)
        );
        assert_eq!(
            parse_sha256sums(&text, "rbx-cli-0.1.0-x86_64-pc-windows-msvc.zip"),
            Some("b".repeat(64))
        );
        assert_eq!(parse_sha256sums(&text, "missing.tar.gz"), None);
        assert_eq!(parse_sha256sums("short  x.tar.gz", "x.tar.gz"), None);
        assert!(pinned_sha256("nothing").is_none());
    }

    #[test]
    fn every_release_target_of_the_pinned_version_has_a_checksum() {
        for target in RELEASE_TARGETS {
            let asset = asset_name(RBX_CLI_VERSION, target);
            let hash = pinned_sha256(&asset)
                .unwrap_or_else(|| panic!("PINNED_SHA256 has no entry for {asset}"));
            assert_eq!(hash.len(), 64);
            assert!(hash
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
        assert_eq!(
            PINNED_SHA256.len(),
            RELEASE_TARGETS.len(),
            "stale pins for an old version?"
        );
        // このビルドのターゲットも表に含まれる。
        if let Some(t) = target_triple() {
            assert!(RELEASE_TARGETS.contains(&t));
        }
    }

    fn info(protocol: u32, caps: &[&str]) -> VersionInfo {
        VersionInfo {
            name: "rbx-cli".into(),
            version: "0.1.1".into(),
            protocol,
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn compatibility_requires_protocol_and_capabilities() {
        assert!(check_compatible(&info(1, REQUIRED_CAPABILITIES)).is_ok());
        let newer = check_compatible(&info(2, REQUIRED_CAPABILITIES)).unwrap_err();
        assert!(newer.contains("Crateforge を更新"), "{newer}");
        let older = check_compatible(&info(0, REQUIRED_CAPABILITIES)).unwrap_err();
        assert!(older.contains("rbx-cli を更新"), "{older}");
        let missing = check_compatible(&info(1, &["usb.export"])).unwrap_err();
        assert!(missing.contains("usb.export.cues"), "{missing}");
        // 0.1.0 の capability だけでは足りない (0.1.1 の 3 つが必要)。
        let v010: Vec<&str> = REQUIRED_CAPABILITIES
            .iter()
            .copied()
            .filter(|c| {
                !matches!(
                    *c,
                    "usb.export.stdinEofCancel"
                        | "usb.export.conflictReasons"
                        | "usb.export.keepDeviceChanges"
                )
            })
            .collect();
        let old = check_compatible(&info(1, &v010)).unwrap_err();
        for c in [
            "usb.export.stdinEofCancel",
            "usb.export.conflictReasons",
            "usb.export.keepDeviceChanges",
        ] {
            assert!(old.contains(c), "{old}");
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn extracts_the_binary_from_a_release_tarball() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.gz");
        {
            let f = std::fs::File::create(&archive).unwrap();
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
            let mut builder = tar::Builder::new(gz);
            for (name, body) in [
                (
                    "rbx-cli-0.1.0-x86_64-unknown-linux-gnu/README.md",
                    &b"readme"[..],
                ),
                (
                    "rbx-cli-0.1.0-x86_64-unknown-linux-gnu/rbx-cli",
                    &b"#!/bin/sh\necho hi\n"[..],
                ),
                (
                    "rbx-cli-0.1.0-x86_64-unknown-linux-gnu/LICENSE",
                    &b"gpl"[..],
                ),
            ] {
                let mut h = tar::Header::new_gnu();
                h.set_size(body.len() as u64);
                h.set_mode(0o644);
                h.set_cksum();
                builder.append_data(&mut h, name, body).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
        }
        let dest = tmp.path().join("bin").join("rbx-cli");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        extract_binary(&archive, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"#!/bin/sh\necho hi\n");
        let names = |dir: &Path| -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            v.sort();
            v
        };
        assert_eq!(names(dest.parent().unwrap()), vec!["rbx-cli".to_string()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "must be executable");
        }

        // 実行ファイルを含まないアーカイブはエラーで、何も残さない。
        let bad = tmp.path().join("bad.tar.gz");
        {
            let f = std::fs::File::create(&bad).unwrap();
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
            let mut builder = tar::Builder::new(gz);
            let mut h = tar::Header::new_gnu();
            h.set_size(1);
            h.set_cksum();
            builder
                .append_data(&mut h, "x/README.md", &b"x"[..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let dest2 = tmp.path().join("bin").join("other");
        assert!(extract_binary(&bad, &dest2).is_err());
        assert!(!dest2.exists());
        assert_eq!(
            names(dest.parent().unwrap()),
            vec!["rbx-cli".to_string()],
            "no partial files left behind"
        );
    }

    #[test]
    fn download_lock_is_exclusive_and_released() {
        let tmp = tempfile::tempdir().unwrap();
        let a = DownloadLock::acquire(tmp.path()).unwrap();
        let err = DownloadLock::acquire(tmp.path()).err().unwrap();
        assert!(err.contains("別の Crateforge"), "{err}");
        drop(a);
        assert!(!tmp.path().join(DOWNLOAD_LOCK).exists());
        let b = DownloadLock::acquire(tmp.path()).unwrap();
        drop(b);
        // 古い残骸のロックは取り直す。
        let lock = tmp.path().join(DOWNLOAD_LOCK);
        std::fs::write(&lock, "1").unwrap();
        let old = std::time::SystemTime::now() - STALE_LOCK - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let c = DownloadLock::acquire(tmp.path()).unwrap();
        drop(c);
        assert!(!lock.exists());
    }

    /// 実際の GitHub Release から取得する (ネットワークが要るので既定では実行しない)。
    /// `cargo test -- --ignored rbx_cli::tests::downloads_the_real_release`
    #[test]
    #[ignore = "downloads the real rbx-cli release from GitHub"]
    fn downloads_the_real_release() {
        let Some(target) = target_triple() else {
            return;
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tmp = tempfile::tempdir().unwrap();
        // 本番と同じクライアント設定。サンドボックス等で TLS を中継するプロキシがある場合だけ、
        // SSL_CERT_FILE の CA を追加で信頼する (アプリ本体の信頼ストアは変えない)。
        let mut builder = reqwest::Client::builder().user_agent("Crateforge");
        if let Some(pem) = std::env::var_os("SSL_CERT_FILE").and_then(|p| std::fs::read(p).ok()) {
            for cert in reqwest::Certificate::from_pem_bundle(&pem).unwrap_or_default() {
                builder = builder.add_root_certificate(cert);
            }
        }
        let client = builder.build().unwrap();
        let events = std::sync::Mutex::new(Vec::<String>::new());
        let record = |p: RbxCliProgress| {
            let kind = serde_json::to_value(&p).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string();
            events.lock().unwrap().push(kind);
        };

        // 1. 固定したチェックサムで取得 → 展開 → version --json で互換確認。
        let dest = tmp.path().join("bin").join(RBX_CLI_VERSION).join(EXE);
        let info = rt
            .block_on(download_to(&client, target, &dest, None, &record))
            .unwrap();
        assert_eq!(info.version, RBX_CLI_VERSION);
        assert_eq!(info.protocol, wire::PROTOCOL_VERSION);
        assert!(dest.is_file());
        let leftovers: Vec<_> = std::fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            leftovers,
            vec![EXE.to_string()],
            "no .part files left behind"
        );
        let kinds = events.lock().unwrap().clone();
        assert!(kinds.contains(&"download".to_string()));
        assert!(kinds.ends_with(&["verify".to_string(), "extract".to_string()]));
        eprintln!(
            "downloaded rbx-cli {} ({}) to {}",
            info.version,
            info.target,
            dest.display()
        );

        // 2. チェックサムが違えば何も置かずに失敗する。
        let bad = tmp.path().join("bad").join(EXE);
        let err = rt
            .block_on(download_to(
                &client,
                target,
                &bad,
                Some("0".repeat(64)),
                &|_| {},
            ))
            .unwrap_err();
        assert!(err.contains("チェックサムが一致しません"), "{err}");
        assert!(!bad.exists());
        assert_eq!(
            std::fs::read_dir(bad.parent().unwrap()).unwrap().count(),
            0,
            "the .part archive is removed"
        );
    }
}
