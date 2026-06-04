//! 音声解析パイプライン: decode → 特徴抽出 → `track_analysis` 保存。
//!
//! 重い処理 (デコード + DSP) は単一のバックグラウンドワーカで逐次実行する。
//! フロントは `analyze_tracks` でトラック ID を投げ、進捗は `analysis-progress`
//! イベントで受け取る。ワーカが 1 本なので二重解析や競合は起きない。

mod decode;
mod features;
pub mod similarity;

use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use crate::db::analysis::ANALYSIS_VERSION;
use crate::db::Database;
use crate::models::{AnalysisProgress, TrackAnalysis};

/// 1 ファイルを解析して `TrackAnalysis` を作る (DB 非依存・単体テスト可能)。
pub fn analyze_path(path: &str, track_id: i64) -> Result<TrackAnalysis, String> {
    let (mono, rate) = decode::decode_mono(path)?;
    let f = features::extract(&mono, rate);
    Ok(TrackAnalysis {
        track_id,
        version: ANALYSIS_VERSION,
        analyzed_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        bpm: f.bpm,
        key_camelot: f.key_camelot,
        key_name: f.key_name,
        energy: f.energy,
        loudness_lufs: f.loudness_lufs,
        replaygain_db: f.replaygain_db,
        vector: f.vector,
    })
}

struct Job {
    ids: Vec<i64>,
    force: bool,
}

/// バックグラウンド解析ワーカへのハンドル (Tauri managed state)。
/// `Sender` は `!Sync` なので `Mutex` で包んで Sync 化する。
pub struct Analyzer {
    tx: Mutex<Sender<Job>>,
}

impl Analyzer {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = channel::<Job>();
        std::thread::spawn(move || worker(app, rx));
        Analyzer { tx: Mutex::new(tx) }
    }

    /// 解析対象 ID をワーカへ投入する (空なら無視)。`force` で再解析を強制。
    pub fn submit(&self, ids: Vec<i64>, force: bool) {
        if ids.is_empty() {
            return;
        }
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(Job { ids, force });
        }
    }
}

fn open_db(app: &AppHandle) -> Result<Database, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Database::open(&dir).map_err(|e| e.to_string())
}

fn worker(app: AppHandle, rx: Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        process_batch(&app, job.ids, job.force);
    }
}

fn process_batch(app: &AppHandle, ids: Vec<i64>, force: bool) {
    let db = match open_db(app) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("analyzer: open db failed: {e}");
            return;
        }
    };

    // 重複排除 + 「ファイルがあり、未解析 (or force)」だけに絞る。
    let mut seen = std::collections::HashSet::new();
    let mut todo: Vec<(i64, String)> = Vec::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        let needs = force || db.needs_analysis(id).unwrap_or(true);
        if !needs {
            continue;
        }
        if let Ok(Some(t)) = db.get_track_by_track_id(id) {
            if let Some(p) = t.location_path {
                if !p.is_empty() && Path::new(&p).exists() {
                    todo.push((id, p));
                }
            }
        }
    }

    let total = todo.len();
    if total == 0 {
        return;
    }
    let _ = app.emit("analysis-progress", AnalysisProgress::Start { total });

    let mut analyzed = 0usize;
    let mut failed = 0usize;
    for (i, (id, path)) in todo.iter().enumerate() {
        let result =
            analyze_path(path, *id).and_then(|a| db.upsert_analysis(&a).map_err(|e| e.to_string()));
        let ok = result.is_ok();
        if let Err(e) = result {
            eprintln!("analyzer: track {id} failed: {e}");
            failed += 1;
        } else {
            analyzed += 1;
        }
        let _ = app.emit(
            "analysis-progress",
            AnalysisProgress::Item {
                track_id: *id,
                done: i + 1,
                total,
                ok,
            },
        );
    }

    let _ = app.emit(
        "analysis-progress",
        AnalysisProgress::Finished { analyzed, failed },
    );
}
