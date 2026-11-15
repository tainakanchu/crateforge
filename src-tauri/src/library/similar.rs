//! 類似曲の検索 (GUI の `get_similar` と `GET /api/tracks/:id/similar` の共通手順)。

use crate::analyzer::similarity::{rank_similar, SimilarOpts};
use crate::db::Database;
use crate::models::SimilarHit;

/// `limit` を指定しなかったときの件数 (GUI / API 共通)。
pub const DEFAULT_SIMILAR_LIMIT: usize = 25;

/// `track_id` に似た曲を距離の昇順で最大 `limit` 件返す。
///
/// - 基準曲が未解析 / 特徴ベクトルが空なら空。
/// - 解析結果はあるが tracks 行が無い (または読めない) 曲は黙って飛ばす。そのぶん
///   `limit` より少なく返ることがある (順位付けの後で飛ばすため。従来どおり)。
///
/// 返す `Track.bpm` は DB の値そのまま。実効 BPM (タグ ?? 解析値) への補完は HTTP アダプタが行う。
pub fn similar_hits(
    db: &Database,
    track_id: i64,
    opts: &SimilarOpts,
    limit: usize,
) -> rusqlite::Result<Vec<SimilarHit>> {
    let base = match db.get_analysis(track_id)? {
        Some(b) if !b.vector.is_empty() => b,
        _ => return Ok(Vec::new()),
    };
    let all = db.get_all_analysis()?;
    let ranked = rank_similar(&base, &all, opts, limit);

    let mut hits = Vec::with_capacity(ranked.len());
    for (tid, distance) in ranked {
        if let Ok(Some(track)) = db.get_track_by_track_id(tid) {
            hits.push(SimilarHit { track, distance });
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 曲 + 解析結果 (特徴ベクトル) を 1 件入れる。`with_track` が false なら解析行だけ
    /// (tracks 行が無い「孤児」の解析結果)。
    fn seed(db: &Database, track_id: i64, vector: &str, bpm: f64, key: &str, with_track: bool) {
        let pid = format!("{track_id:016X}");
        if with_track {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, persistent_id, name, file_exists)
                     VALUES (?1, ?2, ?3, 1)",
                    rusqlite::params![track_id, pid, format!("T{track_id}")],
                )
                .unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO track_analysis
                    (persistent_id, track_id, version, analyzed_at, bpm, key_camelot, key_name,
                     energy, loudness_lufs, replaygain_db, vector, peaks)
                 VALUES (?1, ?2, 2, '2026-01-01T00:00:00Z', ?3, ?4, NULL, 0.5, NULL, NULL, ?5, '[]')",
                rusqlite::params![pid, track_id, bpm, key, vector],
            )
            .unwrap();
    }

    fn ids(hits: &[SimilarHit]) -> Vec<i64> {
        hits.iter().map(|h| h.track.track_id).collect()
    }

    fn library() -> Database {
        let db = Database::open_memory().unwrap();
        seed(&db, 1, "[0.0, 0.0]", 120.0, "8A", true);
        seed(&db, 2, "[0.1, 0.0]", 121.0, "8A", true);
        seed(&db, 3, "[0.5, 0.5]", 140.0, "3B", true);
        seed(&db, 4, "[0.2, 0.0]", 122.0, "9A", true);
        db
    }

    /// 距離の昇順で、基準曲自身は含めない。limit で打ち切る。
    #[test]
    fn ranks_by_distance_and_honors_limit() {
        let db = library();
        let opts = SimilarOpts::default();
        let hits = similar_hits(&db, 1, &opts, DEFAULT_SIMILAR_LIMIT).unwrap();
        assert_eq!(ids(&hits), vec![2, 4, 3]);
        assert!(hits.windows(2).all(|w| w[0].distance <= w[1].distance));
        assert_eq!(ids(&similar_hits(&db, 1, &opts, 1).unwrap()), vec![2]);
    }

    /// 絞り込み (BPM 許容差) は順位付けに渡る。
    #[test]
    fn filters_apply() {
        let db = library();
        let opts = SimilarOpts {
            bpm_tol: Some(0.05),
            ..Default::default()
        };
        assert_eq!(ids(&similar_hits(&db, 1, &opts, 25).unwrap()), vec![2, 4]);
    }

    /// 解析結果だけ残って tracks 行が無い曲は飛ばす (順位付けの後なので limit より少なくなる)。
    #[test]
    fn orphan_analysis_rows_are_skipped() {
        let db = library();
        seed(&db, 50, "[0.05, 0.0]", 120.0, "8A", false);
        let opts = SimilarOpts::default();
        assert_eq!(ids(&similar_hits(&db, 1, &opts, 25).unwrap()), vec![2, 4, 3]);
        // 最も近いのは孤児 (50)。limit 1 はそれで埋まり、結果は空になる。
        assert!(similar_hits(&db, 1, &opts, 1).unwrap().is_empty());
    }

    /// 基準曲が未解析 / ベクトル空なら空 (エラーではない)。
    #[test]
    fn unanalyzed_base_is_empty() {
        let db = library();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, file_exists)
                 VALUES (9, 'FFFFFFFFFFFFFFFF', 'No analysis', 1)",
                [],
            )
            .unwrap();
        assert!(similar_hits(&db, 9, &SimilarOpts::default(), 25).unwrap().is_empty());
        assert!(similar_hits(&db, 12345, &SimilarOpts::default(), 25).unwrap().is_empty());
        seed(&db, 10, "[]", 120.0, "8A", true);
        assert!(similar_hits(&db, 10, &SimilarOpts::default(), 25).unwrap().is_empty());
    }
}
