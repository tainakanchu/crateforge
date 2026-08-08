//! federation slave 側の同期用 DB 操作。

use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::{params, OptionalExtension, Result, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::tracks::SEARCH_TEXT_EXPR;
use super::Database;
use crate::models::{Playlist, Track};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSource {
    pub id: i64,
    pub server_id: String,
    pub name: Option<String>,
    pub base_url: String,
    #[serde(skip_serializing)]
    pub token: String,
    pub last_sync_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncedTrackState {
    Missing,
    Owned(Option<String>),
    Collision,
}

/// WRITE-BACK の三者比較に必要な、pull 時点の基準値と現在のローカル行。
#[derive(Debug, Clone)]
pub struct SyncedTrackSnapshot {
    pub persistent_id: String,
    pub base_meta: String,
    pub local: Track,
}

/// WRITE-BACK 対象になり得るローカルプレイリストと、その曲順（persistent ID）。
#[derive(Debug, Clone)]
pub struct SyncedPlaylistSnapshot {
    pub playlist: Playlist,
    pub track_persistent_ids: Vec<String>,
}

/// follow 再同期と容量表示に必要な選択行。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSelectionRecord {
    pub id: i64,
    pub remote_pid: String,
    pub name: String,
    pub policy: String,
    pub landing_root: Option<String>,
    pub base_membership: Option<Vec<String>>,
    pub base_name: Option<String>,
}

/// eviction 前に検証する、同期が所有する曲と着地先の記録。
#[derive(Debug, Clone)]
pub struct SyncedTrackFileRecord {
    pub location_path: Option<String>,
    pub landing_root: Option<String>,
    pub landed_size: Option<i64>,
    pub landed_mtime: Option<i64>,
}

fn file_fingerprint(path: &Path) -> (Option<i64>, Option<i64>) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return (None, None);
    };
    if !metadata.file_type().is_file() {
        return (None, None);
    }
    let size = i64::try_from(metadata.len()).ok();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| i64::try_from(value.as_secs()).ok());
    (size, mtime)
}

impl Database {
    /// どの同期元にもまだ所属していない、ローカル由来のファイル付き曲を返す。
    pub fn list_local_origin_tracks(&self) -> Result<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.track_id, t.persistent_id, t.name, t.artist, t.album_artist,
                    t.composer, t.album, t.genre, t.year, t.rating, t.play_count, t.skip_count,
                    t.total_time_ms, t.date_added, t.date_modified, t.bpm, t.comments,
                    t.location_raw, t.location_path, t.track_type, t.disabled, t.compilation,
                    t.disc_number, t.disc_count, t.track_number, t.track_count, t.file_exists,
                    t.last_played
             FROM tracks t
             WHERE t.file_exists = 1
               AND t.location_path IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM sync_track st WHERE st.persistent_id = t.persistent_id
               )
             ORDER BY t.track_id",
        )?;
        let rows = stmt.query_map([], super::tracks::row_to_track)?;
        rows.collect()
    }

    /// 指定 source に所属する PID を安定順で返す。
    pub fn list_sync_track_persistent_ids(&self, source_id: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT persistent_id FROM sync_track WHERE source_id = ?1 ORDER BY persistent_id",
        )?;
        let rows = stmt.query_map([source_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn upsert_sync_source(
        &self,
        server_id: &str,
        name: Option<&str>,
        base_url: &str,
        token: &str,
    ) -> Result<SyncSource> {
        self.conn.execute(
            "INSERT INTO sync_source (server_id, name, base_url, token)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(server_id) DO UPDATE SET
                 name = excluded.name,
                 base_url = excluded.base_url,
                 token = excluded.token",
            params![server_id, name, base_url, token],
        )?;
        self.get_sync_source_by_server_id(server_id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn get_sync_source(&self, id: i64) -> Result<Option<SyncSource>> {
        self.conn
            .query_row(
                "SELECT id, server_id, name, base_url, token, last_sync_at
                 FROM sync_source WHERE id = ?1",
                [id],
                row_to_source,
            )
            .optional()
    }

    pub fn get_sync_source_by_server_id(&self, server_id: &str) -> Result<Option<SyncSource>> {
        self.conn
            .query_row(
                "SELECT id, server_id, name, base_url, token, last_sync_at
                 FROM sync_source WHERE server_id = ?1",
                [server_id],
                row_to_source,
            )
            .optional()
    }

    pub fn list_sync_sources(&self) -> Result<Vec<SyncSource>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, server_id, name, base_url, token, last_sync_at
             FROM sync_source ORDER BY name COLLATE NOCASE, id",
        )?;
        let rows = stmt.query_map([], row_to_source)?;
        rows.collect()
    }

    /// 同期元が所有する既存曲か、未登録か、衝突しているローカル曲かを返す。
    pub fn synced_track_state(
        &self,
        persistent_id: &str,
        source_id: i64,
    ) -> Result<SyncedTrackState> {
        let row = self
            .conn
            .query_row(
                "SELECT t.location_path, st.source_id
                 FROM tracks t
                 LEFT JOIN sync_track st ON st.persistent_id = t.persistent_id
                 WHERE t.persistent_id = ?1",
                [persistent_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                    ))
                },
            )
            .optional()?;
        Ok(match row {
            None => SyncedTrackState::Missing,
            Some((path, Some(owner))) if owner == source_id => SyncedTrackState::Owned(path),
            Some(_) => SyncedTrackState::Collision,
        })
    }

    /// master DTO を正としてメタデータを更新し、ローカルの persistent_id を維持する。
    /// 既存行では track_id を変えず、新規行だけ MAX+1 を割り当てる。
    pub fn upsert_synced_track(
        &self,
        track: &Track,
        path: &Path,
        source_id: i64,
    ) -> Result<Option<i64>> {
        let persistent_id = track
            .persistent_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let location_path = path.to_string_lossy().to_string();
        let location_raw = crate::itunes_xml::writer::path_to_file_url(&location_path);

        if let Some((track_id, owner)) = self
            .conn
            .query_row(
                "SELECT t.track_id, st.source_id
                 FROM tracks t
                 LEFT JOIN sync_track st ON st.persistent_id = t.persistent_id
                 WHERE t.persistent_id = ?1",
                [persistent_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
            )
            .optional()?
        {
            if owner != Some(source_id) {
                return Ok(None);
            }
            self.update_synced_track(track_id, track, &location_raw, &location_path)?;
            return Ok(Some(track_id));
        }

        let mut attempt = 0;
        loop {
            let track_id: i64 = self.conn.query_row(
                "SELECT COALESCE(MAX(track_id), 0) + 1 FROM tracks",
                [],
                |row| row.get(0),
            )?;
            let inserted = self.conn.execute(
                "INSERT INTO tracks
                    (track_id, persistent_id, name, artist, album_artist, composer, album, genre,
                     year, rating, play_count, skip_count, total_time_ms, date_added, date_modified,
                     bpm, comments, location_raw, location_path, track_type, disabled, compilation,
                     disc_number, disc_count, track_number, track_count, file_exists, last_played)
                 VALUES
                    (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                     ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, 1, ?27)",
                params![
                    track_id,
                    persistent_id,
                    track.name,
                    track.artist,
                    track.album_artist,
                    track.composer,
                    track.album,
                    track.genre,
                    track.year,
                    track.rating,
                    track.play_count,
                    track.skip_count,
                    track.total_time_ms,
                    track.date_added,
                    track.date_modified,
                    track.bpm,
                    track.comments,
                    location_raw,
                    location_path,
                    track.track_type,
                    track.disabled as i32,
                    track.compilation as i32,
                    track.disc_number,
                    track.disc_count,
                    track.track_number,
                    track.track_count,
                    track.last_played,
                ],
            );
            match inserted {
                Ok(_) => {
                    self.recompute_synced_search_text(track_id)?;
                    return Ok(Some(track_id));
                }
                Err(err) if super::should_retry_constraint(&err, attempt) => {
                    if let Some((existing_id, owner)) = self
                        .conn
                        .query_row(
                            "SELECT t.track_id, st.source_id
                             FROM tracks t
                             LEFT JOIN sync_track st ON st.persistent_id = t.persistent_id
                             WHERE t.persistent_id = ?1",
                            [persistent_id],
                            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
                        )
                        .optional()?
                    {
                        if owner != Some(source_id) {
                            return Ok(None);
                        }
                        self.update_synced_track(
                            existing_id,
                            track,
                            &location_raw,
                            &location_path,
                        )?;
                        return Ok(Some(existing_id));
                    }
                    attempt += 1;
                }
                Err(err) => return Err(err),
            }
        }
    }

    fn update_synced_track(
        &self,
        track_id: i64,
        track: &Track,
        location_raw: &str,
        location_path: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET
                 name=?1, artist=?2, album_artist=?3, composer=?4, album=?5, genre=?6,
                 year=?7, rating=?8, play_count=?9, skip_count=?10, total_time_ms=?11,
                 date_added=?12, date_modified=?13, bpm=?14, comments=?15, location_raw=?16,
                 location_path=?17, track_type=?18, disabled=?19, compilation=?20,
                 disc_number=?21, disc_count=?22, track_number=?23, track_count=?24,
                 file_exists=1, last_played=?25
             WHERE track_id=?26",
            params![
                track.name,
                track.artist,
                track.album_artist,
                track.composer,
                track.album,
                track.genre,
                track.year,
                track.rating,
                track.play_count,
                track.skip_count,
                track.total_time_ms,
                track.date_added,
                track.date_modified,
                track.bpm,
                track.comments,
                location_raw,
                location_path,
                track.track_type,
                track.disabled as i32,
                track.compilation as i32,
                track.disc_number,
                track.disc_count,
                track.track_number,
                track.track_count,
                track.last_played,
                track_id,
            ],
        )?;
        self.recompute_synced_search_text(track_id)
    }

    /// 既存の同期曲を取り直したときの着地先だけを更新する。
    /// メタデータは三者マージ側が扱うため触らない。
    pub fn update_synced_track_location(&self, persistent_id: &str, path: &Path) -> Result<()> {
        let location_path = path.to_string_lossy().to_string();
        let location_raw = crate::itunes_xml::writer::path_to_file_url(&location_path);
        self.conn.execute(
            "UPDATE tracks SET location_raw=?1, location_path=?2, file_exists=1
             WHERE persistent_id=?3",
            params![location_raw, location_path, persistent_id],
        )?;
        Ok(())
    }

    fn recompute_synced_search_text(&self, track_id: i64) -> Result<()> {
        self.conn.execute(
            &format!("UPDATE tracks SET search_text = {SEARCH_TEXT_EXPR} WHERE track_id = ?1"),
            [track_id],
        )?;
        Ok(())
    }

    /// master playlist の persistent_id を保ち、ルート直下で所属曲を全置換する。
    pub fn create_or_replace_playlist_with_pid(
        &self,
        playlist: &Playlist,
        track_ids: &[i64],
    ) -> Result<i64> {
        let persistent_id = playlist
            .persistent_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let tx = self.conn.unchecked_transaction()?;
        let existing = tx
            .query_row(
                "SELECT playlist_id FROM playlists WHERE persistent_id = ?1",
                [persistent_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let playlist_id = if let Some(playlist_id) = existing {
            tx.execute(
                "UPDATE playlists SET parent_persistent_id=NULL, name=?1, is_folder=?2,
                     is_smart=?3, is_user_created=0 WHERE playlist_id=?4",
                params![
                    playlist.name,
                    playlist.is_folder as i32,
                    playlist.is_smart as i32,
                    playlist_id,
                ],
            )?;
            playlist_id
        } else {
            let playlist_id: i64 = tx.query_row(
                "SELECT COALESCE(MAX(playlist_id), 0) + 1 FROM playlists",
                [],
                |row| row.get(0),
            )?;
            let sort_order: i64 = tx.query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM playlists",
                [],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, parent_persistent_id, name, is_folder,
                     is_smart, is_user_created, sort_order)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, 0, ?6)",
                params![
                    playlist_id,
                    persistent_id,
                    playlist.name,
                    playlist.is_folder as i32,
                    playlist.is_smart as i32,
                    sort_order,
                ],
            )?;
            playlist_id
        };
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            [playlist_id],
        )?;
        for (index, track_id) in track_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (?1, ?2, ?3)",
                params![playlist_id, track_id, index as i64],
            )?;
        }
        tx.commit()?;
        Ok(playlist_id)
    }

    pub fn record_sync_track(
        &self,
        persistent_id: &str,
        source_id: i64,
        base_meta: &str,
    ) -> Result<()> {
        self.record_sync_track_with_root(persistent_id, source_id, base_meta, None)
    }

    /// provisioning で使った着地ルートも保存し、eviction のファイル境界に使う。
    /// `landing_root` を渡すのはこの実行で実際にファイルを着地させたときだけで、
    /// 着地時フィンガープリントもそのときしか取り直さない（既存曲では既存値を残す）。
    pub fn record_sync_track_with_root(
        &self,
        persistent_id: &str,
        source_id: i64,
        base_meta: &str,
        landing_root: Option<&Path>,
    ) -> Result<()> {
        let (landed_size, landed_mtime) = match landing_root {
            Some(_) => self.landed_fingerprint(persistent_id)?,
            None => (None, None),
        };
        let landing_root = landing_root.map(|path| path.to_string_lossy().to_string());
        self.conn.execute(
            "INSERT INTO sync_track
                (persistent_id, source_id, pulled_at, base_meta, landing_root,
                 landed_size, landed_mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(persistent_id) DO UPDATE SET source_id=excluded.source_id,
                 pulled_at=excluded.pulled_at, base_meta=excluded.base_meta,
                 landing_root=COALESCE(excluded.landing_root, sync_track.landing_root),
                 landed_size=COALESCE(excluded.landed_size, sync_track.landed_size),
                 landed_mtime=COALESCE(excluded.landed_mtime, sync_track.landed_mtime)",
            params![
                persistent_id,
                source_id,
                now(),
                base_meta,
                landing_root,
                landed_size,
                landed_mtime
            ],
        )?;
        Ok(())
    }

    /// 既存の同期曲を取り直したときの着地情報だけを更新する。
    /// base_meta は三者マージ側が管理するため触らない。
    pub fn record_sync_track_landing(
        &self,
        persistent_id: &str,
        landing_root: &Path,
    ) -> Result<()> {
        let (landed_size, landed_mtime) = self.landed_fingerprint(persistent_id)?;
        self.conn.execute(
            "UPDATE sync_track SET landing_root=?1, landed_size=?2, landed_mtime=?3
             WHERE persistent_id=?4",
            params![
                landing_root.to_string_lossy().to_string(),
                landed_size,
                landed_mtime,
                persistent_id
            ],
        )?;
        Ok(())
    }

    /// 現在の着地ファイルのサイズ・更新時刻。以後の dirty 判定の基準になる。
    fn landed_fingerprint(&self, persistent_id: &str) -> Result<(Option<i64>, Option<i64>)> {
        let location_path = self
            .conn
            .query_row(
                "SELECT location_path FROM tracks WHERE persistent_id = ?1",
                [persistent_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(location_path
            .as_deref()
            .map(Path::new)
            .map(file_fingerprint)
            .unwrap_or((None, None)))
    }

    pub fn record_sync_selection(
        &self,
        source_id: i64,
        remote_pid: &str,
        name: &str,
    ) -> Result<()> {
        self.record_sync_selection_with_root(source_id, remote_pid, name, None)
    }

    pub fn record_sync_selection_with_root(
        &self,
        source_id: i64,
        remote_pid: &str,
        name: &str,
        landing_root: Option<&Path>,
    ) -> Result<()> {
        let landing_root = landing_root.map(|path| path.to_string_lossy().to_string());
        self.conn.execute(
            "INSERT INTO sync_selection
                (source_id, kind, remote_pid, name, policy, quality, landing_root, created_at)
             VALUES (?1, 'playlist', ?2, ?3, 'snapshot', 'original', ?4, ?5)
             ON CONFLICT(source_id, kind, remote_pid) DO UPDATE SET name=excluded.name,
                 landing_root=COALESCE(excluded.landing_root, sync_selection.landing_root)",
            params![source_id, remote_pid, name, landing_root, now()],
        )?;
        Ok(())
    }

    /// follow の三者比較基準を、母艦で確認できた曲順・名前へ更新する。
    pub fn record_sync_selection_baseline_with_root(
        &self,
        source_id: i64,
        remote_pid: &str,
        name: &str,
        base_membership: &[String],
        landing_root: Option<&Path>,
    ) -> Result<()> {
        let landing_root = landing_root.map(|path| path.to_string_lossy().to_string());
        let base_membership = serde_json::to_string(base_membership)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        self.conn.execute(
            "INSERT INTO sync_selection
                (source_id, kind, remote_pid, name, policy, quality, landing_root,
                 base_membership, base_name, created_at)
             VALUES (?1, 'playlist', ?2, ?3, 'snapshot', 'original', ?4, ?5, ?3, ?6)
             ON CONFLICT(source_id, kind, remote_pid) DO UPDATE SET name=excluded.name,
                 landing_root=COALESCE(excluded.landing_root, sync_selection.landing_root),
                 base_membership=excluded.base_membership,
                 base_name=excluded.base_name",
            params![
                source_id,
                remote_pid,
                name,
                landing_root,
                base_membership,
                now()
            ],
        )?;
        Ok(())
    }

    /// writeback で母艦へ反映できた分だけ三者比較の基準を進める。
    /// 反映していない側を `None` にすることで、その基準は現状のまま残す。
    /// 対応する selection 行が無い場合は何もしない（基準が無いままでも収束する）。
    pub fn update_sync_selection_baseline(
        &self,
        source_id: i64,
        remote_pid: &str,
        base_name: Option<&str>,
        base_membership: Option<&[String]>,
    ) -> Result<()> {
        if let Some(name) = base_name {
            self.conn.execute(
                "UPDATE sync_selection SET name = ?1, base_name = ?1
                 WHERE source_id = ?2 AND kind = 'playlist' AND remote_pid = ?3",
                params![name, source_id, remote_pid],
            )?;
        }
        if let Some(membership) = base_membership {
            let membership = serde_json::to_string(membership)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            self.conn.execute(
                "UPDATE sync_selection SET base_membership = ?1
                 WHERE source_id = ?2 AND kind = 'playlist' AND remote_pid = ?3",
                params![membership, source_id, remote_pid],
            )?;
        }
        Ok(())
    }

    pub fn touch_sync_source(&self, source_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE sync_source SET last_sync_at = ?1 WHERE id = ?2",
            params![now(), source_id],
        )?;
        Ok(())
    }

    /// source が所有する全曲を、基準 snapshot と現在値の組で返す。
    pub fn list_synced_track_snapshots(&self, source_id: i64) -> Result<Vec<SyncedTrackSnapshot>> {
        let mut stmt = self.conn.prepare(
            "SELECT persistent_id, COALESCE(base_meta, '{}')
             FROM sync_track WHERE source_id = ?1 ORDER BY persistent_id",
        )?;
        let rows = stmt.query_map([source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let baselines = rows.collect::<Result<Vec<_>>>()?;
        let persistent_ids = baselines
            .iter()
            .map(|(persistent_id, _)| persistent_id.clone())
            .collect::<Vec<_>>();
        let locals = self.get_tracks_by_persistent_ids(&persistent_ids)?;
        let local_by_pid = locals
            .into_iter()
            .filter_map(|track| track.persistent_id.clone().map(|pid| (pid, track)))
            .collect::<std::collections::HashMap<_, _>>();
        Ok(baselines
            .into_iter()
            .filter_map(|(persistent_id, base_meta)| {
                local_by_pid
                    .get(&persistent_id)
                    .cloned()
                    .map(|local| SyncedTrackSnapshot {
                        persistent_id,
                        base_meta,
                        local,
                    })
            })
            .collect())
    }

    /// provisioning で選択したプレイリスト（削除済みを含む）の PID と当時の名前。
    pub fn list_sync_selections(&self, source_id: i64) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT remote_pid, COALESCE(name, '') FROM sync_selection
             WHERE source_id = ?1 AND kind = 'playlist' ORDER BY id",
        )?;
        let rows = stmt.query_map([source_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    pub fn list_sync_selection_records(&self, source_id: i64) -> Result<Vec<SyncSelectionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, remote_pid, COALESCE(name, ''), policy, landing_root,
                    base_membership, base_name
             FROM sync_selection
             WHERE source_id = ?1 AND kind = 'playlist' ORDER BY id",
        )?;
        let rows = stmt.query_map([source_id], |row| {
            Ok(SyncSelectionRecord {
                id: row.get(0)?,
                remote_pid: row.get(1)?,
                name: row.get(2)?,
                policy: row.get(3)?,
                landing_root: row.get(4)?,
                base_membership: row
                    .get::<_, Option<String>>(5)?
                    .and_then(|value| serde_json::from_str(&value).ok()),
                base_name: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// UI から変更できる selection policy を snapshot / follow に限定する。
    pub fn set_sync_selection_policy(&self, selection_id: i64, policy: &str) -> Result<()> {
        if !matches!(policy, "snapshot" | "follow") {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let updated = self.conn.execute(
            "UPDATE sync_selection SET policy = ?1 WHERE id = ?2 AND kind = 'playlist'",
            params![policy, selection_id],
        )?;
        if updated == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    /// selection の参照を外す。sync_track/tracks は eviction が孤立曲として扱うため触らない。
    /// `delete_playlist` を立てると、この selection が指すローカルプレイリストも削除して
    /// 所属曲を未参照（= eviction 候補）へ戻す。
    pub fn remove_sync_selection(&self, selection_id: i64, delete_playlist: bool) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let remote_pid: Option<String> = tx
            .query_row(
                "SELECT remote_pid FROM sync_selection WHERE id = ?1",
                [selection_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(remote_pid) = remote_pid else {
            tx.rollback()?;
            return Ok(false);
        };
        tx.execute("DELETE FROM sync_selection WHERE id = ?1", [selection_id])?;
        if delete_playlist {
            // 対応する persistent_id のローカルプレイリスト 1 行だけを消す。
            let playlist_id: Option<i64> = tx
                .query_row(
                    "SELECT playlist_id FROM playlists WHERE persistent_id = ?1",
                    [&remote_pid],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(playlist_id) = playlist_id {
                self.delete_playlist(playlist_id)?;
            }
        }
        tx.commit()?;
        Ok(true)
    }

    /// 指定 PID のローカル track_id を、入力順を保って解決する。
    pub fn synced_track_ids(&self, persistent_ids: &[String]) -> Result<Vec<Option<i64>>> {
        persistent_ids
            .iter()
            .map(|persistent_id| {
                self.conn
                    .query_row(
                        "SELECT track_id FROM tracks WHERE persistent_id = ?1",
                        [persistent_id],
                        |row| row.get(0),
                    )
                    .optional()
            })
            .collect()
    }

    pub fn update_sync_track_base(&self, persistent_id: &str, base_meta: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE sync_track SET base_meta = ?1, pulled_at = ?2 WHERE persistent_id = ?3",
            params![base_meta, now(), persistent_id],
        )?;
        Ok(())
    }

    /// どのプレイリストからも参照されていない、指定 source 所有曲を返す。
    pub fn unreferenced_synced_track_snapshots(
        &self,
        source_id: i64,
    ) -> Result<Vec<SyncedTrackSnapshot>> {
        let referenced = {
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT t.persistent_id
                 FROM playlist_tracks pt
                 JOIN tracks t ON t.track_id = pt.track_id
                 WHERE t.persistent_id IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<HashSet<_>>>()?
        };
        Ok(self
            .list_synced_track_snapshots(source_id)?
            .into_iter()
            .filter(|row| !referenced.contains(&row.persistent_id))
            .collect())
    }

    pub fn synced_track_file_record(
        &self,
        persistent_id: &str,
    ) -> Result<Option<SyncedTrackFileRecord>> {
        self.conn
            .query_row(
                "SELECT t.location_path, st.landing_root,
                        st.landed_size, st.landed_mtime
                 FROM sync_track st
                 JOIN tracks t ON t.persistent_id = st.persistent_id
                 WHERE st.persistent_id = ?1",
                [persistent_id],
                |row| {
                    Ok(SyncedTrackFileRecord {
                        location_path: row.get(0)?,
                        landing_root: row.get(1)?,
                        landed_size: row.get(2)?,
                        landed_mtime: row.get(3)?,
                    })
                },
            )
            .optional()
    }

    /// IMMEDIATE transaction 内で所有・全 playlist 参照・metadata dirty を再確認して削除する。
    pub fn delete_synced_track_if_eligible(&self, persistent_id: &str) -> Result<bool> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let owned = tx
            .query_row(
                "SELECT t.track_id, COALESCE(st.base_meta, '') FROM tracks t
                 JOIN sync_track st ON st.persistent_id = t.persistent_id
                 WHERE t.persistent_id = ?1",
                [persistent_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((track_id, base_meta)) = owned else {
            tx.rollback()?;
            return Ok(false);
        };
        let referenced: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM playlist_tracks WHERE track_id = ?1)",
            [track_id],
            |row| row.get(0),
        )?;
        let local = tx.query_row(
            "SELECT * FROM tracks WHERE track_id = ?1",
            [track_id],
            super::tracks::row_to_track,
        )?;
        if referenced
            || crate::sync::writeback::has_local_changes(&base_meta, &local).unwrap_or(true)
        {
            tx.rollback()?;
            return Ok(false);
        }
        tx.execute(
            "DELETE FROM track_analysis WHERE persistent_id = ?1",
            [persistent_id],
        )?;
        tx.execute(
            "DELETE FROM sync_track WHERE persistent_id = ?1",
            [persistent_id],
        )?;
        tx.execute("DELETE FROM tracks WHERE track_id = ?1", [track_id])?;
        tx.commit()?;
        Ok(true)
    }

    /// provisioning 済み、または source 所有曲だけを含むローカル作成プレイリストを返す。
    /// 空のローカル作成プレイリストは同期元を特定できないため対象外にする。
    pub fn list_synced_playlist_snapshots(
        &self,
        source_id: i64,
    ) -> Result<Vec<SyncedPlaylistSnapshot>> {
        let selected = self
            .list_sync_selections(source_id)?
            .into_iter()
            .map(|(pid, _)| pid)
            .collect::<HashSet<_>>();
        let owned = self
            .list_synced_track_snapshots(source_id)?
            .into_iter()
            .map(|row| row.persistent_id)
            .collect::<HashSet<_>>();
        let mut output = Vec::new();
        for playlist in self.get_playlists()? {
            let Some(pid) = playlist.persistent_id.as_deref() else {
                continue;
            };
            let tracks = self.get_playlist_tracks(playlist.playlist_id, i64::MAX, 0, None, None)?;
            let track_persistent_ids = tracks
                .into_iter()
                .filter_map(|track| track.persistent_id)
                .collect::<Vec<_>>();
            let provisioned = selected.contains(pid);
            let local_for_source = playlist.is_user_created
                && !playlist.is_folder
                && !playlist.is_smart
                && !track_persistent_ids.is_empty()
                && track_persistent_ids.iter().all(|pid| owned.contains(pid));
            if provisioned || local_for_source {
                output.push(SyncedPlaylistSnapshot {
                    playlist,
                    track_persistent_ids,
                });
            }
        }
        Ok(output)
    }

    /// master-only 値を scoped metadata だけに反映する。再生統計などは一切触らない。
    pub fn apply_writeback_pull(
        &self,
        persistent_id: &str,
        fields: &[(String, serde_json::Value, serde_json::Value)],
        master_date_modified: Option<&str>,
    ) -> Result<Vec<String>> {
        fn sql_value(value: &serde_json::Value) -> Result<rusqlite::types::Value> {
            Ok(match value {
                serde_json::Value::Null => rusqlite::types::Value::Null,
                serde_json::Value::String(value) => rusqlite::types::Value::Text(value.clone()),
                serde_json::Value::Bool(value) => {
                    rusqlite::types::Value::Integer(i64::from(*value))
                }
                serde_json::Value::Number(value) => rusqlite::types::Value::Integer(
                    value.as_i64().ok_or(rusqlite::Error::InvalidQuery)?,
                ),
                _ => return Err(rusqlite::Error::InvalidQuery),
            })
        }

        let tx = self.conn.unchecked_transaction()?;
        let mut skipped = Vec::new();
        let mut applied = 0usize;
        let mut touches_search = false;
        for (field, value, previous) in fields {
            let (column, search) = match field.as_str() {
                "rating" => ("rating", false),
                "name" => ("name", true),
                "artist" => ("artist", true),
                "albumArtist" => ("album_artist", true),
                "composer" => ("composer", false),
                "album" => ("album", true),
                "genre" => ("genre", true),
                "comments" => ("comments", true),
                "year" => ("year", false),
                "bpm" => ("bpm", false),
                "trackNumber" => ("track_number", false),
                "trackCount" => ("track_count", false),
                "discNumber" => ("disc_number", false),
                "discCount" => ("disc_count", false),
                "compilation" => ("compilation", false),
                _ => continue,
            };
            let changed = tx.execute(
                &format!(
                    "UPDATE tracks SET {column} = ?1
                     WHERE persistent_id = ?2 AND {column} IS ?3"
                ),
                rusqlite::params![sql_value(value)?, persistent_id, sql_value(previous)?],
            )?;
            if changed == 0 {
                skipped.push(field.clone());
            } else {
                applied += 1;
                touches_search |= search;
            }
        }
        // 一部でも競合した場合は、そのローカル編集の時計を母艦時刻で潰さない。
        if applied > 0 && skipped.is_empty() {
            tx.execute(
                "UPDATE tracks SET date_modified = ?1 WHERE persistent_id = ?2",
                rusqlite::params![master_date_modified, persistent_id],
            )?;
        }
        if touches_search {
            tx.execute(
                &format!(
                    "UPDATE tracks SET search_text = {SEARCH_TEXT_EXPR} WHERE persistent_id = ?1"
                ),
                [persistent_id],
            )?;
        }
        tx.commit()?;
        Ok(skipped)
    }

    /// ローカル作成 playlist を master が採番した persistent ID へ結び直す。
    pub fn adopt_master_playlist_identity(
        &self,
        playlist_id: i64,
        source_id: i64,
        master_pid: &str,
        name: &str,
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let old_pid: Option<String> = tx.query_row(
            "SELECT persistent_id FROM playlists WHERE playlist_id = ?1",
            [playlist_id],
            |row| row.get(0),
        )?;
        if let Some(old_pid) = old_pid {
            tx.execute(
                "UPDATE playlists SET parent_persistent_id = ?1 WHERE parent_persistent_id = ?2",
                params![master_pid, old_pid],
            )?;
        }
        tx.execute(
            "UPDATE playlists SET persistent_id = ?1 WHERE playlist_id = ?2",
            params![master_pid, playlist_id],
        )?;
        tx.execute(
            "INSERT INTO sync_selection
                (source_id, kind, remote_pid, name, policy, quality, created_at)
             VALUES (?1, 'playlist', ?2, ?3, 'writeback', 'original', ?4)
             ON CONFLICT(source_id, kind, remote_pid) DO UPDATE SET name=excluded.name",
            params![source_id, master_pid, name, now()],
        )?;
        tx.commit()
    }
}

fn row_to_source(row: &rusqlite::Row) -> Result<SyncSource> {
    Ok(SyncSource {
        id: row.get(0)?,
        server_id: row.get(1)?,
        name: row.get(2)?,
        base_url: row.get(3)?,
        token: row.get(4)?,
        last_sync_at: row.get(5)?,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(pid: &str, name: &str, rating: i64) -> Track {
        Track {
            id: 999,
            track_id: 999,
            persistent_id: Some(pid.to_string()),
            name: Some(name.to_string()),
            artist: Some("Artist".to_string()),
            album_artist: None,
            composer: None,
            album: Some("Album".to_string()),
            genre: Some("House".to_string()),
            year: Some(2026),
            rating: Some(rating),
            play_count: Some(7),
            skip_count: Some(2),
            total_time_ms: Some(123_000),
            date_added: Some("2026-01-01T00:00:00Z".to_string()),
            date_modified: Some("2026-01-02T00:00:00Z".to_string()),
            bpm: Some(128),
            comments: Some("master".to_string()),
            location_raw: Some("file:///master/song.mp3".to_string()),
            location_path: Some("/master/song.mp3".to_string()),
            track_type: Some("File".to_string()),
            disabled: false,
            compilation: false,
            disc_number: Some(1),
            disc_count: Some(1),
            track_number: Some(1),
            track_count: Some(10),
            file_exists: true,
            last_played: Some("2026-01-03T00:00:00Z".to_string()),
        }
    }

    #[test]
    fn sync_table_migration_is_idempotent() {
        let db = Database::open_memory().unwrap();
        super::super::migrate_sync_tables(&db.conn).unwrap();
        super::super::migrate_sync_tables(&db.conn).unwrap();
        for table in ["sync_source", "sync_selection", "sync_track"] {
            let exists: bool = db
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "missing {table}");
        }
        for (table, column) in [
            ("sync_selection", "base_membership"),
            ("sync_selection", "base_name"),
            ("sync_track", "landed_size"),
            ("sync_track", "landed_mtime"),
        ] {
            assert!(
                super::super::column_exists(&db.conn, table, column).unwrap(),
                "missing {table}.{column}"
            );
        }
    }

    #[test]
    fn selection_policy_update_is_limited_to_supported_values() {
        let db = Database::open_memory().unwrap();
        let source = db
            .upsert_sync_source("policy-server", Some("Policy"), "http://policy", "token")
            .unwrap();
        db.record_sync_selection(source.id, "AAAABBBBCCCCDDDD", "Selection")
            .unwrap();
        let selection = db.list_sync_selection_records(source.id).unwrap().remove(0);

        db.set_sync_selection_policy(selection.id, "follow")
            .unwrap();
        assert_eq!(
            db.list_sync_selection_records(source.id).unwrap()[0].policy,
            "follow"
        );
        assert!(db
            .set_sync_selection_policy(selection.id, "writeback")
            .is_err());
        assert!(db.set_sync_selection_policy(-1, "snapshot").is_err());
    }

    #[test]
    fn remove_sync_selection_deletes_only_the_selection_row() {
        let db = Database::open_memory().unwrap();
        let source = db
            .upsert_sync_source("remove-server", Some("Remove"), "http://remove", "token")
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name) VALUES (1, 'AAAABBBBCCCCDDDD', 'Kept')",
                [],
            )
            .unwrap();
        db.record_sync_selection(source.id, "REMOVEPID0000001", "Selection")
            .unwrap();
        let selection = db.list_sync_selection_records(source.id).unwrap().remove(0);

        assert!(db.remove_sync_selection(selection.id, false).unwrap());
        assert!(db
            .list_sync_selection_records(source.id)
            .unwrap()
            .is_empty());
        assert!(!db.remove_sync_selection(selection.id, false).unwrap());

        let track_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE persistent_id='AAAABBBBCCCCDDDD'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(track_count, 1);
    }

    #[test]
    fn remove_sync_selection_with_playlist_frees_tracks_for_eviction() {
        let db = Database::open_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.mp3");
        std::fs::write(&path, b"audio").unwrap();
        let source = db
            .upsert_sync_source("drop-server", Some("Drop"), "http://drop", "token")
            .unwrap();
        let value = track("DR0PDR0PDR0PDR01", "Dropped", 20);
        let track_id = db
            .upsert_synced_track(&value, &path, source.id)
            .unwrap()
            .unwrap();
        db.record_sync_track_with_root(
            "DR0PDR0PDR0PDR01",
            source.id,
            &serde_json::to_string(&value).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        let playlist = Playlist {
            id: 1,
            playlist_id: 1,
            persistent_id: Some("DR0PL15TDR0PL151".to_string()),
            parent_persistent_id: None,
            name: "Dropped selection".to_string(),
            is_folder: false,
            is_smart: false,
            is_user_created: false,
            track_count: 1,
        };
        let playlist_id = db
            .create_or_replace_playlist_with_pid(&playlist, &[track_id])
            .unwrap();
        db.record_sync_selection_with_root(
            source.id,
            "DR0PL15TDR0PL151",
            "Dropped selection",
            Some(dir.path()),
        )
        .unwrap();
        let selection = db.list_sync_selection_records(source.id).unwrap().remove(0);
        assert!(db
            .unreferenced_synced_track_snapshots(source.id)
            .unwrap()
            .is_empty());

        assert!(db.remove_sync_selection(selection.id, true).unwrap());

        assert_eq!(
            db.unreferenced_synced_track_snapshots(source.id)
                .unwrap()
                .into_iter()
                .map(|row| row.persistent_id)
                .collect::<Vec<_>>(),
            vec!["DR0PDR0PDR0PDR01"]
        );
        let playlist_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM playlists WHERE playlist_id=?1",
                [playlist_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(playlist_count, 0);
        assert!(db.get_playlist_track_ids(playlist_id).unwrap().is_empty());
    }

    #[test]
    fn synced_track_preserves_pid_allocates_id_and_refreshes_metadata() {
        let db = Database::open_memory().unwrap();
        let source = db
            .upsert_sync_source("server-one", Some("One"), "http://one", "token")
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name) VALUES (41, '0000111122223333', 'Other')",
                [],
            )
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.mp3");
        std::fs::write(&path, b"audio").unwrap();

        let first = db
            .upsert_synced_track(&track("AAAABBBBCCCCDD01", "First", 80), &path, source.id)
            .unwrap();
        assert_eq!(first, Some(42));
        db.record_sync_track_with_root("AAAABBBBCCCCDD01", source.id, "{}", Some(dir.path()))
            .unwrap();
        let fingerprint = db
            .synced_track_file_record("AAAABBBBCCCCDD01")
            .unwrap()
            .unwrap();
        assert_eq!(fingerprint.landed_size, Some(5));
        assert!(fingerprint.landed_mtime.is_some());
        let second = db
            .upsert_synced_track(
                &track("AAAABBBBCCCCDD01", "Refreshed", 100),
                &path,
                source.id,
            )
            .unwrap();
        assert_eq!(second, first);

        let stored = db
            .get_tracks_by_persistent_ids(&["AAAABBBBCCCCDD01".to_string()])
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(stored.persistent_id.as_deref(), Some("AAAABBBBCCCCDD01"));
        assert_eq!(stored.name.as_deref(), Some("Refreshed"));
        assert_eq!(stored.rating, Some(100));
        assert_eq!(stored.play_count, Some(7));
        assert_eq!(stored.location_path.as_deref(), path.to_str());

        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE persistent_id='AAAABBBBCCCCDD01'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn landed_fingerprint_only_moves_when_the_file_was_landed_again() {
        let db = Database::open_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.mp3");
        std::fs::write(&path, b"audio").unwrap();
        let source = db
            .upsert_sync_source("fp-server", Some("FP"), "http://fp", "token")
            .unwrap();
        let value = track("F1NGERPR1NT00001", "Landed", 40);
        db.upsert_synced_track(&value, &path, source.id).unwrap();
        db.record_sync_track_with_root(
            "F1NGERPR1NT00001",
            source.id,
            &serde_json::to_string(&value).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        // 着地後にファイルが差し替わっても、着地させていない再記録では基準を進めない。
        std::fs::write(&path, b"audio-modified-locally").unwrap();

        db.record_sync_track("F1NGERPR1NT00001", source.id, "{}")
            .unwrap();
        let preserved = db
            .synced_track_file_record("F1NGERPR1NT00001")
            .unwrap()
            .unwrap();
        assert_eq!(preserved.landed_size, Some(5));
        assert_eq!(preserved.landing_root.as_deref(), dir.path().to_str());

        db.record_sync_track_landing("F1NGERPR1NT00001", dir.path())
            .unwrap();
        let relanded = db
            .synced_track_file_record("F1NGERPR1NT00001")
            .unwrap()
            .unwrap();
        assert_eq!(relanded.landed_size, Some(22));
    }

    #[test]
    fn writeback_pull_skips_a_field_changed_after_planning() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks
                    (track_id, persistent_id, name, album, rating, search_text)
                 VALUES (1, 'AAAABBBBCCCCDDDD', 'Song', 'Local Edit', 60, '')",
                [],
            )
            .unwrap();

        let skipped = db
            .apply_writeback_pull(
                "AAAABBBBCCCCDDDD",
                &[(
                    "album".to_string(),
                    serde_json::json!("Master"),
                    serde_json::json!("Planned Local"),
                )],
                Some("2026-07-22T00:00:00Z"),
            )
            .unwrap();

        assert_eq!(skipped, vec!["album"]);
        let album: String = db
            .conn
            .query_row(
                "SELECT album FROM tracks WHERE persistent_id='AAAABBBBCCCCDDDD'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(album, "Local Edit");
    }

    #[test]
    fn synced_playlist_keeps_pid_flattens_parent_and_replaces_membership() {
        let db = Database::open_memory().unwrap();
        for id in 1..=3 {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, persistent_id, name) VALUES (?1, ?2, ?3)",
                    params![id, format!("TRACK{id:011}"), format!("Track {id}")],
                )
                .unwrap();
        }
        let playlist = Playlist {
            id: 99,
            playlist_id: 100,
            persistent_id: Some("1111222233334444".to_string()),
            parent_persistent_id: Some("FFFFEEEEDDDDCCCC".to_string()),
            name: "Remote".to_string(),
            is_folder: false,
            is_smart: false,
            is_user_created: false,
            track_count: 3,
        };
        let first = db
            .create_or_replace_playlist_with_pid(&playlist, &[1, 2, 3])
            .unwrap();
        let second = db
            .create_or_replace_playlist_with_pid(&playlist, &[3, 1])
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(db.get_playlist_track_ids(first).unwrap(), vec![3, 1]);
        let (pid, parent): (String, Option<String>) = db
            .conn
            .query_row(
                "SELECT persistent_id, parent_persistent_id FROM playlists WHERE playlist_id=?1",
                [first],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pid, "1111222233334444");
        assert_eq!(parent, None);
    }

    #[test]
    fn synced_track_rejects_local_and_cross_source_collisions() {
        let db = Database::open_memory().unwrap();
        let source_one = db
            .upsert_sync_source("server-one", Some("One"), "http://one", "token-one")
            .unwrap();
        let source_two = db
            .upsert_sync_source("server-two", Some("Two"), "http://two", "token-two")
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.mp3");
        std::fs::write(&path, b"audio").unwrap();
        let path_string = path.to_string_lossy().to_string();

        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, location_path)
                 VALUES (1, '0000000000000001', 'Local', ?1)",
                [path_string],
            )
            .unwrap();
        assert_eq!(
            db.synced_track_state("0000000000000001", source_one.id)
                .unwrap(),
            SyncedTrackState::Collision
        );
        assert_eq!(
            db.upsert_synced_track(
                &track("0000000000000001", "Remote", 100),
                &path,
                source_one.id,
            )
            .unwrap(),
            None
        );

        let owned_id = db
            .upsert_synced_track(
                &track("0000000000000002", "From One", 80),
                &path,
                source_one.id,
            )
            .unwrap()
            .unwrap();
        db.record_sync_track("0000000000000002", source_one.id, "{}")
            .unwrap();
        assert_eq!(
            db.synced_track_state("0000000000000002", source_two.id)
                .unwrap(),
            SyncedTrackState::Collision
        );
        assert_eq!(
            db.upsert_synced_track(
                &track("0000000000000002", "From Two", 100),
                &path,
                source_two.id,
            )
            .unwrap(),
            None
        );
        let names: (String, String) = (
            db.conn
                .query_row("SELECT name FROM tracks WHERE track_id=1", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            db.conn
                .query_row(
                    "SELECT name FROM tracks WHERE track_id=?1",
                    [owned_id],
                    |row| row.get(0),
                )
                .unwrap(),
        );
        assert_eq!(names, ("Local".to_string(), "From One".to_string()));
    }
}
