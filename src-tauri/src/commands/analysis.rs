use tauri::AppHandle;

use crate::analyzer::similarity::{rank_similar, smooth_order, SimilarOpts};
use crate::analyzer::Analyzer;
use crate::commands::library::open_db;
use crate::models::{AnalysisStatus, SimilarHit, TrackAnalysis};

/// 指定トラックの解析をバックグラウンドキューへ投入する。
/// `force` で解析済みでも再解析する。進捗は `analysis-progress` イベントで届く。
#[tauri::command]
pub fn analyze_tracks(
    track_ids: Vec<i64>,
    force: Option<bool>,
    analyzer: tauri::State<'_, Analyzer>,
) -> Result<(), String> {
    analyzer.submit(track_ids, force.unwrap_or(false));
    Ok(())
}

/// 1 曲の解析結果を取得 (未解析なら null)。
#[tauri::command]
pub fn get_analysis(app: AppHandle, track_id: i64) -> Result<Option<TrackAnalysis>, String> {
    let db = open_db(&app)?;
    db.get_analysis(track_id).map_err(|e| e.to_string())
}

/// 解析の進捗サマリ (解析済み / 総数)。
#[tauri::command]
pub fn get_analysis_status(app: AppHandle) -> Result<AnalysisStatus, String> {
    let db = open_db(&app)?;
    let (analyzed, total) = db.analysis_status().map_err(|e| e.to_string())?;
    Ok(AnalysisStatus { analyzed, total })
}

/// 解析済みの全曲を返す (フロントが key/energy 列をまとめて引く / 類似度の母集合)。
#[tauri::command(async)]
pub fn get_all_analyses(app: AppHandle) -> Result<Vec<TrackAnalysis>, String> {
    let db = open_db(&app)?;
    db.get_all_analysis().map_err(|e| e.to_string())
}

/// `track_id` に似た曲を距離昇順で返す。
/// `bpm_tol` (base 比の割合) / `key_compatible` (Camelot 互換) / `energy_tol` で絞り込み可能。
/// 基準曲が未解析なら空を返す。
#[tauri::command(async)]
pub fn get_similar(
    app: AppHandle,
    track_id: i64,
    limit: Option<usize>,
    bpm_tol: Option<f64>,
    key_compatible: Option<bool>,
    energy_tol: Option<f64>,
) -> Result<Vec<SimilarHit>, String> {
    let db = open_db(&app)?;
    let base = match db.get_analysis(track_id).map_err(|e| e.to_string())? {
        Some(b) if !b.vector.is_empty() => b,
        _ => return Ok(Vec::new()),
    };
    let all = db.get_all_analysis().map_err(|e| e.to_string())?;
    let opts = SimilarOpts {
        bpm_tol,
        key_compatible: key_compatible.unwrap_or(false),
        energy_tol,
    };
    let ranked = rank_similar(&base, &all, &opts, limit.unwrap_or(25));

    let mut hits = Vec::with_capacity(ranked.len());
    for (tid, distance) in ranked {
        if let Ok(Some(track)) = db.get_track_by_track_id(tid) {
            hits.push(SimilarHit { track, distance });
        }
    }
    Ok(hits)
}

/// crate 等の track_id 列を貪欲最近傍で「滑らかな並び」に並べ替えて返す。
/// 解析済みの曲だけを並べ替え、未解析の曲は元の順序で末尾に付ける。
#[tauri::command]
pub fn build_smooth_order(app: AppHandle, track_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    let db = open_db(&app)?;
    let mut with_vec: Vec<(i64, Vec<f64>)> = Vec::new();
    let mut without: Vec<i64> = Vec::new();
    for id in &track_ids {
        match db.get_analysis(*id) {
            Ok(Some(a)) if !a.vector.is_empty() => with_vec.push((*id, a.vector)),
            _ => without.push(*id),
        }
    }
    let mut ordered = smooth_order(&with_vec);
    ordered.extend(without);
    Ok(ordered)
}
