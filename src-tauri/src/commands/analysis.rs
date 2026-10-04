use serde::Serialize;
use tauri::AppHandle;

use crate::analyzer::similarity::{smooth_order, SimilarOpts};
use crate::analyzer::Analyzer;
use crate::commands::library::open_db;
use crate::models::{AnalysisStatus, SimilarHit, TrackAnalysis};

/// `get_all_analyses` の 1 行。[`TrackAnalysis`] から特徴ベクトルだけを除いたもの (#213)。
/// フロントはベクトルを「空かどうか」(未解析判定) にしか使わないため、36k 曲分の
/// ベクトル (IPC で十数 MB) を送らず `has_vector` で代替する。類似度計算は Rust 側で完結する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSummary {
    pub track_id: i64,
    pub version: i64,
    pub analyzed_at: String,
    pub bpm: Option<f64>,
    pub key_camelot: Option<String>,
    pub key_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_camelot_user: Option<String>,
    pub energy: Option<f64>,
    pub loudness_lufs: Option<f64>,
    pub replaygain_db: Option<f64>,
    /// 特徴ベクトルが空でないか (旧 `vector.length > 0`)。
    pub has_vector: bool,
    /// 一覧では常に空 (従来どおり)。
    pub peaks: Vec<f32>,
}

impl From<&TrackAnalysis> for AnalysisSummary {
    fn from(a: &TrackAnalysis) -> Self {
        AnalysisSummary {
            track_id: a.track_id,
            version: a.version,
            analyzed_at: a.analyzed_at.clone(),
            bpm: a.bpm,
            key_camelot: a.key_camelot.clone(),
            key_name: a.key_name.clone(),
            key_camelot_user: a.key_camelot_user.clone(),
            energy: a.energy,
            loudness_lufs: a.loudness_lufs,
            replaygain_db: a.replaygain_db,
            has_vector: !a.vector.is_empty(),
            peaks: a.peaks.clone(),
        }
    }
}

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

/// 解析済みの全曲を返す (フロントが key/energy 列をまとめて引く)。
/// 特徴ベクトルは送らず `hasVector` のみ ([`AnalysisSummary`])。
#[tauri::command(async)]
pub fn get_all_analyses(app: AppHandle) -> Result<Vec<AnalysisSummary>, String> {
    let db = open_db(&app)?;
    let all = db.get_all_analysis_cached().map_err(|e| e.to_string())?;
    Ok(all.iter().map(AnalysisSummary::from).collect())
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
    let opts = SimilarOpts {
        bpm_tol,
        key_compatible: key_compatible.unwrap_or(false),
        energy_tol,
    };
    db.similar_hits(track_id, &opts, limit.unwrap_or(25))
        .map_err(|e| e.to_string())
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
