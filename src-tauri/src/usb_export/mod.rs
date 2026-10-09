//! USB 書き出し (rekordbox 互換 / CDJ 向け) のジョブ実行。
//!
//! 実際の書き出しは外部の GPL CLI `rbx-cli` が行う (`crate::rbx_cli` 参照)。ここでは
//! 1. 選択プレイリストから rbx-cli のリクエストを作り (`request.rs`、Traktor の
//!    キュー / グリッドは `crate::traktor_nml` から)、一時ファイルに書いて `--input` で渡す。
//! 2. `rbx-cli --json usb export ... --stdin-control` を起動し、stdout の NDJSON を 1 行ずつ
//!    読んで `usb-export-progress` イベント ([`UsbExportProgress`]) に変換して配信する。
//! 3. 中止は stdin に `cancel` 行を書く (rbx-cli のプロトコル)。一定時間で終わらなければ kill。
//!    子プロセスは `kill_on_drop` で、アプリ終了時は [`UsbExportRuntime::kill_now`] で必ず止める。
//!
//! ライブラリ DB には何も書かない (読み取りのみ)。

#[cfg(test)]
mod e2e_tests;
pub mod errors;
pub mod request;
pub mod wire;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use errors::UsbExportError;
use wire::{Envelope, ExportResult};

/// 中止要求 (`cancel` 行) の後、強制終了するまでの猶予。rbx-cli は曲の区切りで中止を
/// 確認するので、解析中の 1 曲 / コピー中の 1 ファイルが終わるまで待つ。
const CANCEL_GRACE: Duration = Duration::from_secs(30);

/// 実行の種類。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    /// `--dry-run` (計画)。
    Plan,
    /// 実際の書き出し。
    Export,
}

/// `usb-export-progress` イベント。
// NOTE: 内部タグ付き enum のフィールドを camelCase にするには `rename_all_fields` が要る (models.rs 参照)。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum UsbExportProgress {
    Started {
        job: JobKind,
        tracks: usize,
        destination: String,
    },
    /// rbx-cli の `progress` 行。`phase`: plan / analyze / check / copy / database / verify / publish。
    Phase {
        job: JobKind,
        phase: String,
        current: u64,
        total: u64,
        title: Option<String>,
    },
    TrackSkipped {
        job: JobKind,
        index: Option<usize>,
        path: String,
        reason: String,
    },
    TrackWarning {
        job: JobKind,
        index: Option<usize>,
        message: String,
    },
    /// rbx-cli の warn / error ログ。
    Log {
        job: JobKind,
        level: String,
        message: String,
    },
    Finished {
        job: JobKind,
        result: Box<ExportResult>,
    },
    Failed {
        job: JobKind,
        error: UsbExportError,
    },
}

/// NDJSON 1 行 → UI イベント (`result` / `error` は終端なので None。呼び出し側が扱う)。
pub fn envelope_to_event(env: &Envelope, job: JobKind) -> Option<UsbExportProgress> {
    match env {
        Envelope::Progress(p) => Some(UsbExportProgress::Phase {
            job,
            phase: p.phase.clone(),
            current: p.current,
            total: p.total,
            title: p
                .item
                .as_ref()
                .map(|i| i.title.clone())
                .filter(|t| !t.is_empty()),
        }),
        Envelope::Event(e) => {
            let index = e
                .data
                .get("index")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let s = |k: &str| {
                e.data
                    .get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            match e.event.as_str() {
                "track.skipped" => Some(UsbExportProgress::TrackSkipped {
                    job,
                    index,
                    path: s("path"),
                    reason: s("reason"),
                }),
                "track.warning" => Some(UsbExportProgress::TrackWarning {
                    job,
                    index,
                    message: s("message"),
                }),
                _ => None, // 未知のイベントは無視 (プロトコル上の前方互換)
            }
        }
        Envelope::Log(l) if l.level == "warn" || l.level == "error" => {
            Some(UsbExportProgress::Log {
                job,
                level: l.level.clone(),
                message: l.message.clone(),
            })
        }
        _ => None,
    }
}

// ============================================================ runtime

/// 実行中の 1 回分。
pub struct ActiveRun {
    pub job: JobKind,
    child: Mutex<Option<tokio::process::Child>>,
    stdin: tokio::sync::Mutex<Option<tokio::process::ChildStdin>>,
    cancel_requested: AtomicBool,
}

impl ActiveRun {
    fn kill(&self) {
        if let Some(c) = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            let _ = c.start_kill();
        }
    }
}

/// 単一実行ガード (managed state)。同時に 1 つの plan / export しか走らせない。
#[derive(Default)]
pub struct UsbExportRuntime {
    active: Mutex<Option<Arc<ActiveRun>>>,
}

impl UsbExportRuntime {
    fn begin(&self, job: JobKind) -> Result<Arc<ActiveRun>, UsbExportError> {
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(run) = slot.as_ref() {
            return Err(errors::local(
                "busy",
                match run.job {
                    JobKind::Plan => "計画を作成中です。終わるまでお待ちください。",
                    JobKind::Export => {
                        "USB への書き出しを実行中です。終わるか中止してから操作してください。"
                    }
                },
            ));
        }
        let run = Arc::new(ActiveRun {
            job,
            child: Mutex::new(None),
            stdin: tokio::sync::Mutex::new(None),
            cancel_requested: AtomicBool::new(false),
        });
        *slot = Some(run.clone());
        Ok(run)
    }

    fn end(&self, run: &Arc<ActiveRun>) {
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|r| Arc::ptr_eq(r, run)) {
            *slot = None;
        }
    }

    /// 実行中のジョブ (無ければ None)。
    pub fn current(&self) -> Option<JobKind> {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|r| r.job)
    }

    /// 中止を要求する (stdin に `cancel`)。猶予後も終わらなければ kill。実行中でなければ false。
    pub async fn cancel(&self) -> bool {
        let Some(run) = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        else {
            return false;
        };
        run.cancel_requested.store(true, Ordering::SeqCst);
        let wrote = {
            let mut stdin = run.stdin.lock().await;
            match stdin.as_mut() {
                Some(s) => s.write_all(b"cancel\n").await.is_ok() && s.flush().await.is_ok(),
                None => false,
            }
        };
        if !wrote {
            run.kill();
            return true;
        }
        let late = run.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(CANCEL_GRACE).await;
            late.kill();
        });
        true
    }

    /// アプリ終了時: 実行中の子プロセスを即座に止める (孤児にしない)。
    /// rbx-cli は新しい世代を退避領域に書いてから原子的に公開するため、途中で止めても
    /// USB には以前のライブラリが残る (次回の書き出しで後片付けされる)。
    pub fn kill_now(&self) {
        if let Some(run) = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            run.cancel_requested.store(true, Ordering::SeqCst);
            run.kill();
        }
    }
}

/// 終了時に必ず単一実行ガードと一時ファイルを片付ける。
struct RunCleanup {
    app: AppHandle,
    run: Arc<ActiveRun>,
    request_file: PathBuf,
}

impl Drop for RunCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.request_file);
        self.app.state::<UsbExportRuntime>().end(&self.run);
    }
}

fn request_file_path() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "crateforge-usb-export-{}-{nanos}.json",
        std::process::id()
    ))
}

/// ジョブの開始 (単一実行ガードの取得 + リクエストの書き出し)。
pub struct Prepared {
    run: Arc<ActiveRun>,
    cleanup: RunCleanup,
}

/// 単一実行ガードを取り、リクエストを一時ファイルに書く。
pub fn prepare(
    app: &AppHandle,
    job: JobKind,
    request: &wire::ExportRequest,
) -> Result<Prepared, UsbExportError> {
    let run = app.state::<UsbExportRuntime>().begin(job)?;
    let request_file = request_file_path();
    let cleanup = RunCleanup {
        app: app.clone(),
        run: run.clone(),
        request_file: request_file.clone(),
    };
    let json = serde_json::to_vec(request)
        .map_err(|e| errors::local("internal", format!("リクエストの作成に失敗: {e}")))?;
    std::fs::write(&request_file, json).map_err(|e| {
        errors::local(
            "io",
            format!("一時ファイルを書けません ({}): {e}", request_file.display()),
        )
    })?;
    Ok(Prepared { run, cleanup })
}

fn emit(app: &AppHandle, ev: UsbExportProgress) {
    let _ = app.emit("usb-export-progress", ev);
}

/// rbx-cli を起動して終わるまで NDJSON を中継する。終端の `Finished` / `Failed` も配信する。
pub async fn run(
    app: &AppHandle,
    exe: &Path,
    prepared: Prepared,
    destination: &str,
    tracks: usize,
) -> Result<ExportResult, UsbExportError> {
    let job = prepared.run.job;
    emit(
        app,
        UsbExportProgress::Started {
            job,
            tracks,
            destination: destination.to_string(),
        },
    );
    let outcome = run_inner(app, exe, &prepared, destination).await;
    // 終端イベントより先にガードを外す (受け取った UI がすぐ次の計画を始められるように)。
    drop(prepared);
    match &outcome {
        Ok(result) => emit(
            app,
            UsbExportProgress::Finished {
                job,
                result: Box::new(result.clone()),
            },
        ),
        Err(error) => emit(
            app,
            UsbExportProgress::Failed {
                job,
                error: error.clone(),
            },
        ),
    }
    outcome
}

async fn run_inner(
    app: &AppHandle,
    exe: &Path,
    prepared: &Prepared,
    destination: &str,
) -> Result<ExportResult, UsbExportError> {
    let run = &prepared.run;
    let job = run.job;
    let mut cmd = crate::rbx_cli::command(exe);
    cmd.arg("--json")
        .args(["usb", "export", "--input"])
        .arg(&prepared.cleanup.request_file)
        .arg("--to")
        .arg(destination)
        .arg("--stdin-control")
        .stdin(std::process::Stdio::piped());
    if job == JobKind::Plan {
        cmd.arg("--dry-run");
    }
    let mut child = cmd.spawn().map_err(|e| {
        errors::local(
            "spawn",
            format!("rbx-cli を起動できません ({}): {e}", exe.display()),
        )
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *run.stdin.lock().await = child.stdin.take();
    *run.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    // 起動前に中止が来ていたら (競合) すぐ止める。
    if run.cancel_requested.load(Ordering::SeqCst) {
        run.kill();
    }

    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut tail: Vec<String> = Vec::new();
        if let Some(err) = stderr {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                tail.push(l);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
        tail.join("\n")
    });

    let mut result: Option<serde_json::Value> = None;
    let mut error: Option<wire::ErrorLine> = None;
    if let Some(out) = stdout {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(env) = wire::parse_line(&line) else {
                continue;
            };
            match env {
                Envelope::Result(data) => result = Some(data),
                Envelope::Error(e) => error = Some(e),
                other => {
                    if let Some(ev) = envelope_to_event(&other, job) {
                        emit(app, ev);
                    }
                }
            }
        }
    }

    // stdout が閉じた = 終了間際。終了コードを短い間隔で拾う (kill と同じロックを使うため)。
    let status = loop {
        let polled = run
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
            .map(|c| c.try_wait());
        match polled {
            Some(Ok(Some(status))) => break Some(status),
            Some(Ok(None)) => tokio::time::sleep(Duration::from_millis(50)).await,
            _ => break None,
        }
    };
    *run.stdin.lock().await = None;
    let stderr_tail = stderr_task.await.unwrap_or_default();

    if let Some(e) = error {
        return Err(errors::from_error_line(&e));
    }
    if let Some(data) = result {
        return serde_json::from_value::<ExportResult>(data)
            .map_err(|e| errors::local("internal", format!("rbx-cli の結果を読めません: {e}")));
    }
    if run.cancel_requested.load(Ordering::SeqCst) {
        return Err(errors::local(
            "cancelled",
            "書き出しを中止しました（rbx-cli を強制終了しました）。USB には以前の内容が残っており、次回の書き出しで後片付けされます。",
        ));
    }
    let code = status
        .and_then(|s| s.code())
        .map_or("?".to_string(), |c| c.to_string());
    Err(errors::local(
        "crashed",
        format!(
            "rbx-cli が結果を返さずに終了しました (exit {code}){}",
            if stderr_tail.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr_tail.trim())
            }
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_events_serialize_fields_in_camel_case() {
        let v = serde_json::to_value(UsbExportProgress::TrackSkipped {
            job: JobKind::Export,
            index: Some(5),
            path: "/m/gone.mp3".into(),
            reason: "missing".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "trackSkipped", "job": "export", "index": 5,
                "path": "/m/gone.mp3", "reason": "missing"
            })
        );
        let v = serde_json::to_value(UsbExportProgress::Failed {
            job: JobKind::Plan,
            error: errors::local("busy", "x"),
        })
        .unwrap();
        assert_eq!(v["kind"], "failed");
        assert_eq!(v["job"], "plan");
        assert_eq!(v["error"]["cueConflict"], false);
        let v = serde_json::to_value(UsbExportProgress::Finished {
            job: JobKind::Export,
            result: Box::default(),
        })
        .unwrap();
        assert_eq!(v["result"]["dryRun"], false);
        assert!(v["result"]["tracks"].get("requested").is_some());
        assert!(v["result"]["bytes"].get("toCopy").is_some());
    }

    #[test]
    fn ndjson_lines_become_progress_events() {
        let lines = [
            r#"{"type":"progress","protocol":1,"command":"usb.export","phase":"plan","current":0,"total":2}"#,
            r#"{"type":"progress","protocol":1,"command":"usb.export","phase":"analyze","current":1,"total":2,"item":{"index":0,"ref":"a","title":"Alpha"}}"#,
            r#"{"type":"event","protocol":1,"command":"usb.export","event":"track.skipped","data":{"index":1,"ref":"b","path":"/m/b.mp3","reason":"missing"}}"#,
            r#"{"type":"event","protocol":1,"command":"usb.export","event":"track.warning","data":{"index":0,"ref":"a","message":"grid ignored"}}"#,
            r#"{"type":"event","protocol":1,"command":"usb.export","event":"track.future","data":{}}"#,
            r#"{"type":"log","protocol":1,"level":"debug","message":"noise"}"#,
            r#"{"type":"log","protocol":1,"level":"warn","message":"could not store analysis in the cache"}"#,
            r#"{"type":"result","protocol":1,"command":"usb.export","data":{}}"#,
        ];
        let events: Vec<UsbExportProgress> = lines
            .iter()
            .filter_map(|l| wire::parse_line(l))
            .filter_map(|e| envelope_to_event(&e, JobKind::Export))
            .collect();
        assert_eq!(
            events,
            vec![
                UsbExportProgress::Phase {
                    job: JobKind::Export,
                    phase: "plan".into(),
                    current: 0,
                    total: 2,
                    title: None
                },
                UsbExportProgress::Phase {
                    job: JobKind::Export,
                    phase: "analyze".into(),
                    current: 1,
                    total: 2,
                    title: Some("Alpha".into())
                },
                UsbExportProgress::TrackSkipped {
                    job: JobKind::Export,
                    index: Some(1),
                    path: "/m/b.mp3".into(),
                    reason: "missing".into()
                },
                UsbExportProgress::TrackWarning {
                    job: JobKind::Export,
                    index: Some(0),
                    message: "grid ignored".into()
                },
                UsbExportProgress::Log {
                    job: JobKind::Export,
                    level: "warn".into(),
                    message: "could not store analysis in the cache".into()
                },
            ]
        );
    }

    #[test]
    fn runtime_allows_one_run_at_a_time() {
        let rt = UsbExportRuntime::default();
        let a = rt.begin(JobKind::Plan).unwrap();
        assert_eq!(rt.current(), Some(JobKind::Plan));
        let busy = rt.begin(JobKind::Export).err().unwrap();
        assert_eq!(busy.code, "busy");
        // 別の run の end では外れない。
        let other = Arc::new(ActiveRun {
            job: JobKind::Export,
            child: Mutex::new(None),
            stdin: tokio::sync::Mutex::new(None),
            cancel_requested: AtomicBool::new(false),
        });
        rt.end(&other);
        assert_eq!(rt.current(), Some(JobKind::Plan));
        rt.end(&a);
        assert_eq!(rt.current(), None);
        assert!(rt.begin(JobKind::Export).is_ok());
        rt.kill_now(); // 子プロセスが無くても安全
    }
}
