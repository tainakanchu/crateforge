//! USB 書き出し (rekordbox 互換 / CDJ 向け) と rbx-cli 管理の Tauri コマンド。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::library::open_db;
use crate::rbx_cli::{self, RbxCliStatus};
use crate::traktor_nml;
use crate::usb_export::errors::{self, UsbExportError};
use crate::usb_export::request::{self, BuildReport, TraktorInput, UsbExportOptions};
use crate::usb_export::wire::{DeviceInfo, DevicesResult, ExportResult};
use crate::usb_export::{self as job, JobKind, UsbExportRuntime};

/// ユーザーが指定した collection.nml のパスを保存する `app_state` のキー。
const NML_STATE_KEY: &str = "traktor_nml_path";

// ============================================================ rbx-cli

/// rbx-cli の状態 (場所・取得元・バージョン・互換性)。
#[tauri::command]
pub async fn get_rbx_cli_status(app: AppHandle) -> RbxCliStatus {
    rbx_cli::status(&app).await
}

/// rbx-cli を取得する。進捗は `rbx-cli-progress` で配信。
#[tauri::command]
pub async fn download_rbx_cli(app: AppHandle) -> Result<String, String> {
    rbx_cli::download(&app)
        .await
        .map(|p| p.display().to_string())
}

/// rbx-cli のパスを手動指定する (None / 空で解除)。
#[tauri::command]
pub async fn set_rbx_cli_path(
    app: AppHandle,
    path: Option<String>,
) -> Result<RbxCliStatus, String> {
    rbx_cli::set_override_path(&app, path.as_deref())?;
    Ok(rbx_cli::status(&app).await)
}

// ============================================================ Traktor NML

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraktorNmlStatus {
    /// ユーザーが指定したパス。
    pub override_path: Option<String>,
    /// 自動検出したパス (`~/Documents/Native Instruments/Traktor */collection.nml` の最新版)。
    pub detected_path: Option<String>,
    /// 実際に使うパス (指定 ?? 自動検出)。
    pub effective_path: Option<String>,
    pub exists: bool,
}

fn nml_override(app: &AppHandle) -> Option<String> {
    open_db(app)
        .ok()?
        .get_state(NML_STATE_KEY)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn documents_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(d) = app.path().document_dir() {
        dirs.push(d);
    }
    if let Ok(h) = app.path().home_dir() {
        let d = h.join("Documents");
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

fn nml_status(app: &AppHandle) -> TraktorNmlStatus {
    let override_path = nml_override(app);
    let detected_path =
        traktor_nml::detect_default(&documents_dirs(app)).map(|p| p.display().to_string());
    let effective_path = override_path.clone().or_else(|| detected_path.clone());
    let exists = effective_path
        .as_deref()
        .is_some_and(|p| std::path::Path::new(p).is_file());
    TraktorNmlStatus {
        override_path,
        detected_path,
        effective_path,
        exists,
    }
}

#[tauri::command]
pub fn get_traktor_nml_status(app: AppHandle) -> TraktorNmlStatus {
    nml_status(&app)
}

/// collection.nml の場所を手動指定する (None / 空で自動検出に戻す)。
#[tauri::command]
pub fn set_traktor_nml_path(
    app: AppHandle,
    path: Option<String>,
) -> Result<TraktorNmlStatus, String> {
    let db = open_db(&app)?;
    db.set_state(NML_STATE_KEY, path.as_deref().map(str::trim).unwrap_or(""))
        .map_err(|e| e.to_string())?;
    Ok(nml_status(&app))
}

// ============================================================ devices

/// マウント中のボリューム (rbx-cli `devices list`)。
#[tauri::command]
pub async fn usb_list_devices(app: AppHandle) -> Result<Vec<DeviceInfo>, String> {
    let exe = rbx_cli::ensure(&app).await?;
    let data = rbx_cli::run_json(&exe, &["devices", "list"])
        .await
        .map_err(|e| e.message())?;
    let parsed: DevicesResult =
        serde_json::from_value(data).map_err(|e| format!("デバイス一覧を読めません: {e}"))?;
    Ok(parsed.devices)
}

/// ボリュームを取り出す (rbx-cli `devices eject`、強制はしない)。
#[tauri::command]
pub async fn usb_eject(app: AppHandle, mount_point: String) -> Result<(), String> {
    if app.state::<UsbExportRuntime>().current().is_some() {
        return Err("書き出し中は取り出せません".to_string());
    }
    let exe = rbx_cli::ensure(&app).await?;
    // `--` の後に置く (`-` で始まるマウントポイントをオプションと解釈させない)。
    rbx_cli::run_json_with_timeout(
        &exe,
        &["devices", "eject", "--", &mount_point],
        rbx_cli::EJECT_TIMEOUT,
    )
    .await
    .map(|_| ())
    .map_err(|e| match e {
        rbx_cli::RunError::Cli(line) if line.code == "not_found" => {
            "このボリュームは取り出せません（デバイス一覧にありません）。".to_string()
        }
        other => format!("取り出しに失敗しました: {}", other.message()),
    })
}

// ============================================================ export

/// 計画 (dry-run) の結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbExportPlan {
    /// crateforge 側でのリクエスト作成結果 (見つからない曲・Traktor 照合)。
    pub build: BuildReport,
    /// rbx-cli の dry-run 結果 (コピー / 再利用 / 解析の見込み、容量)。
    pub result: ExportResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbExportStatus {
    pub running: bool,
    pub job: Option<JobKind>,
    /// 実行中の run id (イベントの `runId` と同じ)。
    pub run_id: Option<u64>,
    /// 実行中のジョブの設定 (webview の再読み込み後に UI を復元するため)。
    pub options: Option<UsbExportOptions>,
}

/// 書き出しを開始した結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbExportStarted {
    /// この書き出しの run id (以降のイベントの `runId`)。
    pub run_id: u64,
    pub report: BuildReport,
}

fn file_size(path: &str) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
}

/// リクエストを作る (DB 読み取り + NML 読み込み、ブロッキング)。
async fn build(
    app: &AppHandle,
    options: &UsbExportOptions,
) -> Result<request::Built, UsbExportError> {
    let dest = options.destination.trim();
    if dest.is_empty() {
        return Err(errors::local("invalid", "書き出し先を選んでください。"));
    }
    if !std::path::Path::new(dest).is_dir() {
        return Err(errors::local(
            "not_found",
            format!("書き出し先が見つかりません: {dest}"),
        ));
    }
    let nml_path = if options.use_traktor {
        let p = options
            .nml_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| nml_status(app).effective_path)
            .ok_or_else(|| {
                errors::local(
                    "traktor",
                    "Traktor の collection.nml が見つかりません。場所を指定するか、Traktor のキュー/グリッドを使う設定をオフにしてください。",
                )
            })?;
        Some(p)
    } else {
        None
    };
    let app = app.clone();
    let options = options.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let index = match &nml_path {
            Some(p) => Some(
                traktor_nml::load_cached(std::path::Path::new(p))
                    .map_err(|e| errors::local("traktor", e))?,
            ),
            None => None,
        };
        let db = open_db(&app).map_err(|e| errors::local("db", e))?;
        let traktor = match (&nml_path, &index) {
            (Some(p), Some(i)) => Some(TraktorInput {
                nml_path: p.clone(),
                index: i,
            }),
            _ => None,
        };
        request::build_request(&db, &options, traktor, &file_size)
            .map_err(|e| errors::local("build", e))
    })
    .await
    .map_err(|e| errors::local("internal", format!("リクエストの作成に失敗: {e}")))?
}

async fn exe(app: &AppHandle) -> Result<PathBuf, UsbExportError> {
    rbx_cli::ensure(app)
        .await
        .map_err(|e| errors::local("rbx_cli_missing", e))
}

/// 計画を作る (`usb export --dry-run`)。USB にもキャッシュにも何も書かない。
/// 実行ガードはリクエスト作成の前に取るので、作成中でも `usb_export_cancel` で止められる。
#[tauri::command]
pub async fn usb_export_plan(
    app: AppHandle,
    options: UsbExportOptions,
) -> Result<UsbExportPlan, UsbExportError> {
    let guard = job::begin(&app, JobKind::Plan, &options)?;
    let exe = exe(&app).await?;
    let built = build(&app, &options).await?;
    guard.check_cancelled()?;
    let prepared = job::prepare(guard, &built.request)?;
    let result = job::run(
        &app,
        &exe,
        prepared,
        options.destination.trim(),
        built.request.tracks.len(),
    )
    .await?;
    Ok(UsbExportPlan {
        build: built.report,
        result,
    })
}

/// 書き出しを開始する。すぐに戻り、進捗と結果は `usb-export-progress` で配信する
/// (どのイベントにも戻り値と同じ `runId` が付く)。
#[tauri::command]
pub async fn usb_export_start(
    app: AppHandle,
    options: UsbExportOptions,
) -> Result<UsbExportStarted, UsbExportError> {
    let guard = job::begin(&app, JobKind::Export, &options)?;
    let exe = exe(&app).await?;
    let built = build(&app, &options).await?;
    guard.check_cancelled()?;
    if built.report.found == 0 {
        return Err(errors::local(
            "empty",
            "書き出せる曲がありません（プレイリストが空か、ファイルが見つかりません）。",
        ));
    }
    let prepared = job::prepare(guard, &built.request)?;
    let run_id = prepared.id();
    let tracks = built.request.tracks.len();
    let destination = options.destination.trim().to_string();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = job::run(&handle, &exe, prepared, &destination, tracks).await;
    });
    Ok(UsbExportStarted {
        run_id,
        report: built.report,
    })
}

/// 実行中の計画 / 書き出しを中止する (rbx-cli に `cancel` を送る)。`run_id` / `job` の
/// 指定に合う実行だけを止める (どちらも無ければ何もしない)。止める実行が無ければ false。
#[tauri::command]
pub async fn usb_export_cancel(app: AppHandle, run_id: Option<u64>, job: Option<JobKind>) -> bool {
    app.state::<UsbExportRuntime>()
        .cancel(job::CancelTarget { run_id, job })
        .await
}

#[tauri::command]
pub fn usb_export_status(app: AppHandle) -> UsbExportStatus {
    match app.state::<UsbExportRuntime>().current() {
        Some(info) => UsbExportStatus {
            running: true,
            job: Some(info.job),
            run_id: Some(info.run_id),
            options: Some(info.options),
        },
        None => UsbExportStatus {
            running: false,
            job: None,
            run_id: None,
            options: None,
        },
    }
}

/// アプリ終了時に呼ぶ: 実行中の rbx-cli を止める。
pub fn shutdown(app: &AppHandle) {
    if let Some(rt) = app.try_state::<UsbExportRuntime>() {
        rt.kill_now();
    }
}
