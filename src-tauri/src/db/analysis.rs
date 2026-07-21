//! `track_analysis` テーブルの読み書き。
//!
//! 解析結果 (BPM / Camelot key / energy / loudness / 特徴ベクトル) を曲と 1:1 で保存する。
//! 特徴ベクトルは `Vec<f64>` を JSON 文字列にして `vector` 列に格納する
//! (BLOB より可読・移植性が高く、~20 次元なのでサイズも問題にならない)。

use rusqlite::{params, OptionalExtension, Result};

use super::Database;
use crate::models::TrackAnalysis;

/// 解析アルゴリズムのバージョン。ロジックを更新したら +1 して再解析を促す。
/// v2: 波形ピーク (peaks) を追加。
pub const ANALYSIS_VERSION: i64 = 2;

fn row_to_analysis(row: &rusqlite::Row) -> rusqlite::Result<TrackAnalysis> {
    let vector_json: Option<String> = row.get(9)?;
    let vector = vector_json
        .and_then(|s| serde_json::from_str::<Vec<f64>>(&s).ok())
        .unwrap_or_default();
    Ok(TrackAnalysis {
        track_id: row.get(0)?,
        version: row.get(1)?,
        analyzed_at: row.get(2)?,
        bpm: row.get(3)?,
        key_camelot: row.get(4)?,
        key_name: row.get(5)?,
        energy: row.get(6)?,
        loudness_lufs: row.get(7)?,
        replaygain_db: row.get(8)?,
        vector,
        // peaks は一覧クエリでは読まない (重いため)。get_analysis で個別に充填する。
        peaks: Vec::new(),
    })
}

const SELECT_COLS: &str = "track_id, version, analyzed_at, bpm, key_camelot, key_name, \
                           energy, loudness_lufs, replaygain_db, vector";

impl Database {
    /// 解析結果を挿入 / 更新する (永続 ID を主キーに upsert)。
    /// track_id は現在の tracks から導出し、曲がインポート中に消えた場合は NULL にする。
    pub fn upsert_analysis(&self, persistent_id: &str, a: &TrackAnalysis) -> Result<()> {
        let vector_json = serde_json::to_string(&a.vector).unwrap_or_else(|_| "[]".to_string());
        let peaks_json = serde_json::to_string(&a.peaks).unwrap_or_else(|_| "[]".to_string());
        self.conn.execute(
            "INSERT INTO track_analysis
                (persistent_id, track_id, version, analyzed_at, bpm, key_camelot, key_name,
                 energy, loudness_lufs, replaygain_db, vector, peaks)
             VALUES (?1, (SELECT track_id FROM tracks WHERE persistent_id = ?1),
                     ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(persistent_id) DO UPDATE SET
                track_id = excluded.track_id,
                version = excluded.version,
                analyzed_at = excluded.analyzed_at,
                bpm = excluded.bpm,
                key_camelot = excluded.key_camelot,
                key_name = excluded.key_name,
                energy = excluded.energy,
                loudness_lufs = excluded.loudness_lufs,
                replaygain_db = excluded.replaygain_db,
                vector = excluded.vector,
                peaks = excluded.peaks",
            params![
                persistent_id,
                a.version,
                a.analyzed_at,
                a.bpm,
                a.key_camelot,
                a.key_name,
                a.energy,
                a.loudness_lufs,
                a.replaygain_db,
                vector_json,
                peaks_json,
            ],
        )?;
        Ok(())
    }

    /// 1 曲の解析結果を取得 (未解析なら None)。波形 peaks もここで充填する。
    pub fn get_analysis(&self, track_id: i64) -> Result<Option<TrackAnalysis>> {
        let sql = format!("SELECT {SELECT_COLS} FROM track_analysis WHERE track_id = ?1");
        let mut base = self
            .conn
            .query_row(&sql, params![track_id], row_to_analysis)
            .optional()?;
        if let Some(ref mut a) = base {
            let peaks_json: Option<String> = self
                .conn
                .query_row(
                    "SELECT peaks FROM track_analysis WHERE track_id = ?1",
                    params![track_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            a.peaks = peaks_json
                .and_then(|s| serde_json::from_str::<Vec<f32>>(&s).ok())
                .unwrap_or_default();
        }
        Ok(base)
    }

    /// 解析済みの全曲を取得 (類似度計算の母集合に使う)。
    pub fn get_all_analysis(&self) -> Result<Vec<TrackAnalysis>> {
        let sql = format!("SELECT {SELECT_COLS} FROM track_analysis WHERE track_id IS NOT NULL");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_analysis)?;
        rows.collect()
    }

    /// 指定曲が「現行バージョンで解析済み」かどうか。未解析・旧バージョンなら true。
    pub fn needs_analysis(&self, track_id: i64) -> Result<bool> {
        let analyzed: bool = self.conn.query_row(
            "SELECT EXISTS(
                 SELECT 1
                 FROM tracks
                 JOIN track_analysis
                   ON track_analysis.persistent_id = tracks.persistent_id
                 WHERE tracks.track_id = ?1 AND track_analysis.version = ?2
             )",
            params![track_id, ANALYSIS_VERSION],
            |r| r.get(0),
        )?;
        Ok(!analyzed)
    }

    /// (現行バージョンで解析済みの曲数, ファイルが存在する曲の総数)。
    pub fn analysis_status(&self) -> Result<(i64, i64)> {
        let analyzed: i64 = self.conn.query_row(
            "SELECT COUNT(*)
             FROM track_analysis
             JOIN tracks ON tracks.persistent_id = track_analysis.persistent_id
             WHERE track_analysis.version = ?1",
            params![ANALYSIS_VERSION],
            |r| r.get(0),
        )?;
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE file_exists = 1",
            [],
            |r| r.get(0),
        )?;
        Ok((analyzed, total))
    }
}
