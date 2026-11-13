//! 「変換して置き換え」のバックグラウンドジョブ。
//!
//! デスクトップの変換ダイアログ (Tauri コマンド) とローカル HTTP API の両方から使う。
//! ジョブは別スレッドで 1 曲ずつ処理し、状態はプロセス内のレジストリに置く
//! (API はジョブ ID でポーリングし、ダイアログはイベントで受け取る)。
//! 同じファイルを同時に触らないよう、実行は 1 ジョブずつ (後から来たものは queued で待つ)。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use super::in_place::{self, InPlaceOptions, ItemResult, ItemStatus};
use crate::db::Database;

/// 保持する終了済みジョブの数 (古いものから捨てる)。
const MAX_JOBS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub ok: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub job_id: String,
    pub state: JobState,
    pub options: InPlaceOptions,
    pub total: usize,
    /// 処理済みの曲数。
    pub done: usize,
    pub counts: Counts,
    pub results: Vec<ItemResult>,
    /// ジョブ全体の失敗 (DB を開けない等)。
    pub error: Option<String>,
}

/// 進捗イベント (`convert-replace-progress`)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum JobEvent {
    Start {
        job_id: String,
        total: usize,
    },
    Item {
        job_id: String,
        index: usize,
        total: usize,
        result: ItemResult,
    },
    Done {
        job: JobSnapshot,
    },
}

#[derive(Default)]
struct Registry {
    jobs: HashMap<String, JobSnapshot>,
    order: VecDeque<String>,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// 実行の直列化用。
fn run_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(Default::default)
}

fn new_job_id() -> String {
    let mut b = [0u8; 8];
    if getrandom::getrandom(&mut b).is_err() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        b = (n as u64).to_le_bytes();
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// ジョブの現在の状態。
pub fn get(job_id: &str) -> Option<JobSnapshot> {
    registry().lock().ok()?.jobs.get(job_id).cloned()
}

fn update(job_id: &str, f: impl FnOnce(&mut JobSnapshot)) -> Option<JobSnapshot> {
    let mut reg = registry().lock().ok()?;
    let job = reg.jobs.get_mut(job_id)?;
    f(job);
    Some(job.clone())
}

/// ジョブを登録してバックグラウンドで開始し、ジョブ ID を返す。
/// `open_db` は作業スレッドで呼ぶ (rusqlite の接続はスレッドをまたげない)。
/// `notify` は進捗のたびに作業スレッドから呼ばれる。
pub fn spawn<O, N>(
    track_ids: Vec<i64>,
    opts: InPlaceOptions,
    ffmpeg: PathBuf,
    open_db: O,
    notify: N,
) -> String
where
    O: FnOnce() -> Result<Database, String> + Send + 'static,
    N: Fn(JobEvent) + Send + 'static,
{
    let job_id = new_job_id();
    let total = track_ids.len();
    {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        reg.jobs.insert(
            job_id.clone(),
            JobSnapshot {
                job_id: job_id.clone(),
                state: JobState::Queued,
                options: opts,
                total,
                done: 0,
                counts: Counts::default(),
                results: Vec::new(),
                error: None,
            },
        );
        reg.order.push_back(job_id.clone());
        // 終わったジョブから古い順に捨てる (実行中・待機中は残す)。
        while reg.order.len() > MAX_JOBS {
            let Some(pos) = reg.order.iter().position(|id| {
                reg.jobs
                    .get(id)
                    .is_none_or(|j| matches!(j.state, JobState::Done | JobState::Failed))
            }) else {
                break;
            };
            if let Some(id) = reg.order.remove(pos) {
                reg.jobs.remove(&id);
            }
        }
    }

    let id = job_id.clone();
    std::thread::spawn(move || {
        let _guard = run_lock().lock().unwrap_or_else(|e| e.into_inner());
        update(&id, |j| j.state = JobState::Running);
        notify(JobEvent::Start {
            job_id: id.clone(),
            total,
        });
        let db = match open_db() {
            Ok(db) => db,
            Err(e) => {
                if let Some(job) = update(&id, |j| {
                    j.state = JobState::Failed;
                    j.error = Some(e);
                }) {
                    notify(JobEvent::Done { job });
                }
                return;
            }
        };
        let library_root = crate::importer::library_media_root(&db);
        for (i, track_id) in track_ids.into_iter().enumerate() {
            let r = in_place::replace_one(
                &db,
                track_id,
                &ffmpeg,
                &opts,
                library_root.as_deref(),
                &crate::library_match::replace::os_trash,
            );
            if r.status == ItemStatus::Failed {
                eprintln!(
                    "convert-replace: track {track_id} failed: {:?} {:?}",
                    r.reason, r.message
                );
            }
            update(&id, |j| {
                match r.status {
                    ItemStatus::Ok => j.counts.ok += 1,
                    ItemStatus::Skipped => j.counts.skipped += 1,
                    ItemStatus::Failed => j.counts.failed += 1,
                }
                j.done = i + 1;
                j.results.push(r.clone());
            });
            notify(JobEvent::Item {
                job_id: id.clone(),
                index: i + 1,
                total,
                result: r,
            });
        }
        if let Some(job) = update(&id, |j| j.state = JobState::Done) {
            notify(JobEvent::Done { job });
        }
    });
    job_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConvertFormat;
    use std::sync::mpsc;

    #[test]
    fn job_reports_per_track_results_and_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        let p = dir.path().join("missing.flac").to_string_lossy().to_string();
        let id = db
            .add_imported_track(
                Some("Gone"), None, None, None, None, None, None, None, None, None, None, &p, &p,
            )
            .unwrap();
        drop(db);
        let data_dir = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel();
        let job_id = spawn(
            vec![id, 424242],
            InPlaceOptions {
                format: ConvertFormat::Mp3,
                bitrate_kbps: Some(320),
                original: Default::default(),
            },
            PathBuf::from("ffmpeg"),
            move || Database::open(&data_dir).map_err(|e| e.to_string()),
            move |ev| {
                let _ = tx.send(ev);
            },
        );
        let mut done = None;
        for ev in rx.iter() {
            if let JobEvent::Done { job } = ev {
                done = Some(job);
                break;
            }
        }
        let job = done.unwrap();
        assert_eq!(job.job_id, job_id);
        assert_eq!(job.state, JobState::Done);
        assert_eq!(job.done, 2);
        assert_eq!(job.counts.failed, 2);
        assert_eq!(job.results[0].reason.as_deref(), Some("no_file"));
        assert_eq!(job.results[1].reason.as_deref(), Some("not_found"));
        assert_eq!(get(&job_id).unwrap().state, JobState::Done);
        assert!(get("nope").is_none());
    }
}
