//! 取り込み済み検出 (`library_match`) と既存曲の置き換えのための DB 操作。

use rusqlite::{params, Result};

use super::Database;
use crate::library_match::LibraryRow;
use crate::metadata::tech::TechMeta;

impl Database {
    /// 照合用に全曲の必要列だけを 1 回で読む (数万曲でも 1 クエリ)。
    pub fn library_match_rows(&self) -> Result<Vec<LibraryRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT track_id, name, artist, album_artist, album, total_time_ms,
                    location_path, COALESCE(file_exists, 1)
             FROM tracks",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(LibraryRow {
                track_id: r.get(0)?,
                name: r.get(1)?,
                artist: r.get(2)?,
                album_artist: r.get(3)?,
                album: r.get(4)?,
                total_time_ms: r.get(5)?,
                location_path: r.get(6)?,
                file_exists: r.get::<_, i64>(7)? != 0,
            })
        })?;
        rows.collect()
    }

    /// `track_id` 以外に `path` を参照している曲があるか。
    pub fn other_tracks_reference_path(&self, path: &str, track_id: i64) -> Result<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE location_path = ?1 AND track_id <> ?2",
            params![path, track_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// 既存曲を新しいファイルへ付け替える (置き換え)。1 トランザクションで
    /// 場所・file_exists・長さ・技術メタデータ (COALESCE せず上書き) を更新し、
    /// 解析結果を消す。track_id / persistent_id / プレイリスト / レート / 再生回数 /
    /// 日付 / ユーザー編集のタグ列には触れない。曲が無ければエラー。
    pub fn apply_track_replacement(
        &self,
        track_id: i64,
        path: &str,
        url: &str,
        total_time_ms: Option<i64>,
        tech: &TechMeta,
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let n = tx.execute(
            "UPDATE tracks SET
                 location_path = ?1, location_raw = ?2, file_exists = 1,
                 total_time_ms = COALESCE(?3, total_time_ms),
                 bitrate_kbps = ?4, sample_rate_hz = ?5, bit_depth = ?6,
                 channels = ?7, file_size_bytes = ?8, codec = ?9
             WHERE track_id = ?10",
            params![
                path,
                url,
                total_time_ms,
                tech.bitrate_kbps,
                tech.sample_rate_hz,
                tech.bit_depth,
                tech.channels,
                tech.file_size_bytes,
                tech.codec,
                track_id,
            ],
        )?;
        if n == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        tx.execute(
            "DELETE FROM track_analysis
             WHERE track_id = ?1
                OR persistent_id = (SELECT persistent_id FROM tracks WHERE track_id = ?1)",
            params![track_id],
        )?;
        tx.commit()
    }
}
