//! `track_analysis` テーブルの読み書き。
//!
//! 解析結果 (BPM / Camelot key / energy / loudness / 特徴ベクトル) を曲と 1:1 で保存する。
//! 特徴ベクトルは `Vec<f64>` を JSON 文字列にして `vector` 列に格納する
//! (BLOB より可読・移植性が高く、~20 次元なのでサイズも問題にならない)。

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{params, OptionalExtension, Result};

use super::generation::{self, GenCache, GenKey};
use super::Database;
use crate::analyzer::similarity::{rank_similar, SimilarOpts};
use crate::models::{SimilarHit, TrackAnalysis};

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
        key_camelot_user: row.get(10)?,
        // peaks は一覧クエリでは読まない (重いため)。get_analysis で個別に充填する。
        peaks: Vec::new(),
    })
}

/// 末尾の key_camelot_user は tracks 側の手動 Key 上書き (track_analysis には保存しない。
/// 再解析の upsert で消えないよう、解析行とは別テーブルに置いている)。
/// 解析行 `a` を外側に置いた LEFT JOIN で 1 パスに合成する ([`FROM_ANALYSIS`])。
/// tracks.track_id は UNIQUE なので結合は高々 1 行で、以前の相関サブクエリ
/// `(SELECT key_camelot_user FROM tracks WHERE tracks.track_id = track_analysis.track_id)`
/// と行数・値・行順が一致する (`left_join_matches_correlated_subquery` で検証)。
const SELECT_COLS: &str = "a.track_id, a.version, a.analyzed_at, a.bpm, a.key_camelot, a.key_name, \
                           a.energy, a.loudness_lufs, a.replaygain_db, a.vector, \
                           t.key_camelot_user";

/// [`SELECT_COLS`] と組で使う FROM 句。
const FROM_ANALYSIS: &str = "track_analysis a LEFT JOIN tracks t ON t.track_id = a.track_id";

/// `get_all_analysis` のプロセス内キャッシュ (類似度の母集合)。
/// 36k 曲規模で毎回全行を読み・ベクトルを JSON パースするのを避ける (#213)。
/// 世代キー ([`generation`]) が一致する間だけ使う。スロットは DB の uid。
static ALL_ANALYSIS_CACHE: GenCache<i64, GenKey, Vec<TrackAnalysis>> = GenCache::new(4);

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
        let sql = format!("SELECT {SELECT_COLS} FROM {FROM_ANALYSIS} WHERE a.track_id = ?1");
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

    /// persistent_id 群に対応する解析結果を入力順で返す。見つからない ID は省略する。
    /// SQLite の変数上限を避けるため IN 句を分割し、peaks は要求された場合だけ読む。
    pub fn get_analysis_by_persistent_ids(
        &self,
        persistent_ids: &[String],
        include_peaks: bool,
    ) -> Result<Vec<(String, TrackAnalysis)>> {
        const CHUNK_SIZE: usize = 900;
        let mut found = HashMap::with_capacity(persistent_ids.len());

        for chunk in persistent_ids.chunks(CHUNK_SIZE) {
            if chunk.is_empty() {
                continue;
            }
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let peaks_column = if include_peaks { "a.peaks" } else { "NULL" };
            let sql = format!(
                "SELECT a.persistent_id, {SELECT_COLS}, {peaks_column}
                 FROM {FROM_ANALYSIS}
                 WHERE a.track_id IS NOT NULL AND a.persistent_id IN ({placeholders})"
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                let persistent_id: String = row.get(0)?;
                let vector_json: Option<String> = row.get(10)?;
                let peaks_json: Option<String> = row.get(12)?;
                Ok((
                    persistent_id,
                    TrackAnalysis {
                        track_id: row.get(1)?,
                        version: row.get(2)?,
                        analyzed_at: row.get(3)?,
                        bpm: row.get(4)?,
                        key_camelot: row.get(5)?,
                        key_name: row.get(6)?,
                        energy: row.get(7)?,
                        loudness_lufs: row.get(8)?,
                        replaygain_db: row.get(9)?,
                        vector: vector_json
                            .and_then(|value| serde_json::from_str(&value).ok())
                            .unwrap_or_default(),
                        key_camelot_user: row.get(11)?,
                        peaks: peaks_json
                            .and_then(|value| serde_json::from_str(&value).ok())
                            .unwrap_or_default(),
                    },
                ))
            })?;
            for row in rows {
                let (persistent_id, analysis) = row?;
                found.insert(persistent_id, analysis);
            }
        }

        Ok(persistent_ids
            .iter()
            .filter_map(|persistent_id| {
                found
                    .get(persistent_id)
                    .cloned()
                    .map(|analysis| (persistent_id.clone(), analysis))
            })
            .collect())
    }

    /// 解析済みの全曲を取得 (類似度計算の母集合に使う)。
    pub fn get_all_analysis(&self) -> Result<Vec<TrackAnalysis>> {
        let sql = format!("SELECT {SELECT_COLS} FROM {FROM_ANALYSIS} WHERE a.track_id IS NOT NULL");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_analysis)?;
        rows.collect()
    }

    /// [`get_all_analysis`](Self::get_all_analysis) のキャッシュ版。内容・行順は同一。
    /// 世代 (track_analysis / tracks の書き込みで SQLite トリガが進める) が変わっていれば
    /// 読み直す。世代が読めない場合はキャッシュせずに直接読む。
    pub fn get_all_analysis_cached(&self) -> Result<Arc<Vec<TrackAnalysis>>> {
        // 世代は **データより先に** 読む。読んだ後に書き込みが挟まっても、
        // 新しいデータに古い世代が付くだけ (= 次回は必ず読み直し) で、古いデータを返すことはない。
        let Some(key) = generation::current(&self.conn, "analysis") else {
            return Ok(Arc::new(self.get_all_analysis()?));
        };
        ALL_ANALYSIS_CACHE.get_or_try_insert(key.uid, key, || self.get_all_analysis())
    }

    /// `track_id` に似た曲を距離昇順で返す (Tauri コマンド / LAN API 共通の中核)。
    /// 基準曲が未解析 (ベクトル空) なら空。母集合はキャッシュ版を使い、
    /// ヒット曲は 1 回のバッチ取得で解決する (結果・順序は従来の 1 件ずつ取得と同じ)。
    pub fn similar_hits(
        &self,
        track_id: i64,
        opts: &SimilarOpts,
        limit: usize,
    ) -> Result<Vec<SimilarHit>> {
        let base = match self.get_analysis(track_id)? {
            Some(b) if !b.vector.is_empty() => b,
            _ => return Ok(Vec::new()),
        };
        let all = self.get_all_analysis_cached()?;
        let ranked = rank_similar(&base, &all, opts, limit);

        let ids: Vec<i64> = ranked.iter().map(|(tid, _)| *tid).collect();
        match self.get_tracks_by_ids(&ids) {
            Ok(tracks) => {
                let by_id: HashMap<i64, crate::models::Track> =
                    tracks.into_iter().map(|t| (t.track_id, t)).collect();
                Ok(ranked
                    .into_iter()
                    .filter_map(|(tid, distance)| {
                        by_id.get(&tid).map(|track| SimilarHit {
                            track: track.clone(),
                            distance,
                        })
                    })
                    .collect())
            }
            // 従来は 1 件ずつ取得し、取得エラーの曲は黙って飛ばしていた。
            // バッチ取得が失敗した場合はその挙動にフォールバックする。
            Err(_) => Ok(ranked
                .into_iter()
                .filter_map(|(tid, distance)| match self.get_track_by_track_id(tid) {
                    Ok(Some(track)) => Some(SimilarHit { track, distance }),
                    _ => None,
                })
                .collect()),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 解析あり (上書きあり/なし)・解析なし・孤児 (track_id NULL)・
    /// 既に消えた曲を指す解析行 (track_id=99) を混ぜたフィクスチャ。
    /// 行の挿入順を track_id 順と変えて、自然順 (ORDER BY なし) の一致も確かめる。
    fn fixture() -> Database {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO tracks (track_id, persistent_id, name, key_camelot_user, file_exists) VALUES
                   (1, 'P1', 'one', '3B', 1),
                   (2, 'P2', 'two', NULL, 1),
                   (3, 'P3', 'three', '5A', 1),
                   (4, 'P4', 'four', NULL, 1);
                 INSERT INTO track_analysis
                   (persistent_id, track_id, version, analyzed_at, bpm, key_camelot, key_name,
                    energy, vector, peaks) VALUES
                   ('P2', 2, 2, 't', 128.0, '8A', 'A minor', 0.5, '[0.1,0.2]', '[0.5]'),
                   ('PX', 99, 2, 't', 120.0, '1A', NULL, 0.1, '[0.9,0.9]', NULL),
                   ('P1', 1, 2, 't', 126.0, '8A', 'A minor', 0.6, '[0.1,0.25]', '[0.1]'),
                   ('PN', NULL, 2, 't', 100.0, NULL, NULL, NULL, '[0,0]', NULL),
                   ('P4', 4, 2, 't', 140.0, '9A', NULL, 0.9, '[0.5,0.5]', NULL);",
            )
            .unwrap();
        db
    }

    type Row = (
        i64,
        i64,
        Option<f64>,
        Option<String>,
        Option<String>,
        Option<f64>,
        Vec<f64>,
        Option<String>,
    );

    fn row_of(a: &TrackAnalysis) -> Row {
        (
            a.track_id,
            a.version,
            a.bpm,
            a.key_camelot.clone(),
            a.key_name.clone(),
            a.energy,
            a.vector.clone(),
            a.key_camelot_user.clone(),
        )
    }

    /// #172 の旧 SELECT (相関サブクエリ) をそのまま実行する参照版。
    const OLD_COLS: &str = "track_id, version, analyzed_at, bpm, key_camelot, key_name, \
                            energy, loudness_lufs, replaygain_db, vector, \
                            (SELECT key_camelot_user FROM tracks \
                             WHERE tracks.track_id = track_analysis.track_id)";

    fn old_all(db: &Database) -> Vec<Row> {
        let sql = format!("SELECT {OLD_COLS} FROM track_analysis WHERE track_id IS NOT NULL");
        let mut stmt = db.conn.prepare(&sql).unwrap();
        let rows = stmt.query_map([], row_to_analysis).unwrap();
        rows.map(|r| row_of(&r.unwrap())).collect()
    }

    fn old_one(db: &Database, track_id: i64) -> Option<Row> {
        let sql = format!("SELECT {OLD_COLS} FROM track_analysis WHERE track_id = ?1");
        db.conn
            .query_row(&sql, params![track_id], row_to_analysis)
            .optional()
            .unwrap()
            .map(|a| row_of(&a))
    }

    /// LEFT JOIN 版が旧・相関サブクエリ版と行数・値・行順まで一致すること。
    #[test]
    fn left_join_matches_correlated_subquery() {
        let db = fixture();
        let new_all: Vec<Row> = db.get_all_analysis().unwrap().iter().map(row_of).collect();
        assert_eq!(new_all, old_all(&db));
        // 孤児 (track_id NULL) は含まれず、消えた曲 (99) の行は上書き NULL で残る。
        assert_eq!(new_all.len(), 4);
        let by_id: HashMap<i64, &Row> = new_all.iter().map(|r| (r.0, r)).collect();
        assert_eq!(by_id[&1].7.as_deref(), Some("3B"));
        assert_eq!(by_id[&2].7, None);
        assert_eq!(by_id[&99].7, None);

        for tid in [1, 2, 3, 4, 99, 12345] {
            let new_one = db.get_analysis(tid).unwrap().map(|a| row_of(&a));
            assert_eq!(new_one, old_one(&db, tid), "track_id={tid}");
        }
        // 解析の無い曲 (3) は上書きがあっても None。
        assert!(db.get_analysis(3).unwrap().is_none());
        // peaks は get_analysis でだけ充填。
        assert_eq!(db.get_analysis(2).unwrap().unwrap().peaks, vec![0.5]);

        // persistent_id 指定版: 入力順、未知 / 孤児 ID は省略、上書きも合成。
        let ids: Vec<String> = ["P4", "PN", "P1", "nope", "P2"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let got = db.get_analysis_by_persistent_ids(&ids, true).unwrap();
        let pids: Vec<&str> = got.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(pids, vec!["P4", "P1", "P2"]);
        assert_eq!(got[1].1.key_camelot_user.as_deref(), Some("3B"));
        assert_eq!(got[2].1.peaks, vec![0.5]);
        let no_peaks = db.get_analysis_by_persistent_ids(&ids, false).unwrap();
        assert!(no_peaks.iter().all(|(_, a)| a.peaks.is_empty()));
    }

    fn cached_rows(db: &Database) -> Vec<Row> {
        db.get_all_analysis_cached()
            .unwrap()
            .iter()
            .map(row_of)
            .collect()
    }

    fn uncached_rows(db: &Database) -> Vec<Row> {
        db.get_all_analysis().unwrap().iter().map(row_of).collect()
    }

    fn analysis(track_id: i64, vector: Vec<f64>) -> TrackAnalysis {
        TrackAnalysis {
            track_id,
            version: ANALYSIS_VERSION,
            analyzed_at: "t".into(),
            bpm: Some(128.0),
            key_camelot: Some("8A".into()),
            key_name: None,
            key_camelot_user: None,
            energy: Some(0.5),
            loudness_lufs: None,
            replaygain_db: None,
            vector,
            peaks: vec![],
        }
    }

    /// キャッシュ版は、track_analysis / tracks へのあらゆる経路の書き込みの後で
    /// 必ず最新 (= 非キャッシュ版と同一) を返す。
    #[test]
    fn analysis_cache_invalidates_on_every_write_path() {
        let db = fixture();
        assert_eq!(cached_rows(&db), uncached_rows(&db));
        // 変更なしなら同じ内容 (ヒット)。
        assert_eq!(cached_rows(&db), uncached_rows(&db));

        // 解析ワーカの upsert (新規: 曲 3 を解析)。
        db.upsert_analysis("P3", &analysis(3, vec![0.3, 0.3])).unwrap();
        let rows = cached_rows(&db);
        assert_eq!(rows, uncached_rows(&db));
        assert!(rows.iter().any(|r| r.0 == 3 && r.7.as_deref() == Some("5A")));

        // 再解析 (既存行の更新)。
        db.upsert_analysis("P2", &analysis(2, vec![0.7, 0.7])).unwrap();
        assert_eq!(cached_rows(&db), uncached_rows(&db));

        // LAN API / 同期の生 SQL での書き込み。
        db.conn
            .execute(
                "UPDATE track_analysis SET vector = '[1,1]' WHERE persistent_id = 'P4'",
                [],
            )
            .unwrap();
        assert_eq!(cached_rows(&db), uncached_rows(&db));

        // Key 上書きの変更 (tracks 側の列)。
        db.conn
            .execute("UPDATE tracks SET key_camelot_user = '12B' WHERE track_id = 2", [])
            .unwrap();
        let rows = cached_rows(&db);
        assert_eq!(rows, uncached_rows(&db));
        assert!(rows.iter().any(|r| r.0 == 2 && r.7.as_deref() == Some("12B")));

        // 曲の削除 (解析行もカスケードで消える)。
        crate::db::tracks::delete_track_cascade(&db.conn, 1).unwrap();
        let rows = cached_rows(&db);
        assert_eq!(rows, uncached_rows(&db));
        assert!(rows.iter().all(|r| r.0 != 1));

        // 消えた曲を指していた解析行に、同じ track_id の曲が追加された (上書きが結合される)。
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, key_camelot_user) VALUES (99, 'P99', 'x', '2B')",
                [],
            )
            .unwrap();
        let rows = cached_rows(&db);
        assert_eq!(rows, uncached_rows(&db));
        assert!(rows.iter().any(|r| r.0 == 99 && r.7.as_deref() == Some("2B")));

        // 復元 (DB ファイル差し替え) 相当: エポックが進めば必ず読み直す。
        crate::db::generation::bump_epoch();
        assert_eq!(cached_rows(&db), uncached_rows(&db));
    }

    /// similar_hits が旧実装 (全件読み直し + 1 件ずつ曲を取得) と同じ結果・順序を返す。
    #[test]
    fn similar_hits_match_reference() {
        let db = fixture();
        db.upsert_analysis("P3", &analysis(3, vec![0.1, 0.2])).unwrap();
        let reference = |db: &Database, tid: i64, opts: &SimilarOpts, limit: usize| {
            let base = match db.get_analysis(tid).unwrap() {
                Some(b) if !b.vector.is_empty() => b,
                _ => return Vec::new(),
            };
            let all = db.get_all_analysis().unwrap();
            let mut hits = Vec::new();
            for (t, d) in rank_similar(&base, &all, opts, limit) {
                if let Ok(Some(track)) = db.get_track_by_track_id(t) {
                    hits.push((track.track_id, d));
                }
            }
            hits
        };
        let got = |db: &Database, tid: i64, opts: &SimilarOpts, limit: usize| {
            db.similar_hits(tid, opts, limit)
                .unwrap()
                .into_iter()
                .map(|h| (h.track.track_id, h.distance))
                .collect::<Vec<_>>()
        };
        let plain = SimilarOpts {
            bpm_tol: None,
            key_compatible: false,
            energy_tol: None,
        };
        let keyed = SimilarOpts {
            bpm_tol: None,
            key_compatible: true,
            energy_tol: None,
        };
        for tid in [1, 2, 3, 4, 99, 12345] {
            for limit in [1, 2, 25] {
                assert_eq!(got(&db, tid, &plain, limit), reference(&db, tid, &plain, limit));
                assert_eq!(got(&db, tid, &keyed, limit), reference(&db, tid, &keyed, limit));
            }
        }
        // 消えた曲 (99) の解析行は順位付けには入るが、ヒットとしては返らない。
        assert!(got(&db, 2, &plain, 25).iter().all(|(t, _)| *t != 99));

        // Key 上書きの変更が Key 互換フィルタに反映される。
        let before = got(&db, 2, &keyed, 25);
        db.conn
            .execute("UPDATE tracks SET key_camelot_user = '8A' WHERE track_id = 3", [])
            .unwrap();
        let after = got(&db, 2, &keyed, 25);
        assert_eq!(after, reference(&db, 2, &keyed, 25));
        assert_ne!(before, after);

        // 新規解析した曲が Similar に現れる。
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name) VALUES (5, 'P5', 'five')",
                [],
            )
            .unwrap();
        db.upsert_analysis("P5", &analysis(5, vec![0.1, 0.21])).unwrap();
        let hits = got(&db, 2, &plain, 25);
        assert!(hits.iter().any(|(t, _)| *t == 5));
        assert_eq!(hits, reference(&db, 2, &plain, 25));
    }
}
