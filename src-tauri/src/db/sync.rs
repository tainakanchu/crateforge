//! federation slave 側の同期用 DB 操作。

use std::collections::HashSet;
use std::path::Path;

use rusqlite::{params, OptionalExtension, Result};
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

impl Database {
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
        let location_raw = url::Url::from_file_path(path)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| format!("file://{location_path}"));

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
        self.conn.execute(
            "INSERT INTO sync_track (persistent_id, source_id, pulled_at, base_meta)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(persistent_id) DO UPDATE SET source_id=excluded.source_id,
                 pulled_at=excluded.pulled_at, base_meta=excluded.base_meta",
            params![persistent_id, source_id, now(), base_meta],
        )?;
        Ok(())
    }

    pub fn record_sync_selection(
        &self,
        source_id: i64,
        remote_pid: &str,
        name: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sync_selection
                (source_id, kind, remote_pid, name, policy, quality, created_at)
             VALUES (?1, 'playlist', ?2, ?3, 'snapshot', 'original', ?4)
             ON CONFLICT(source_id, kind, remote_pid) DO UPDATE SET name=excluded.name",
            params![source_id, remote_pid, name, now()],
        )?;
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
        fields: &[(String, serde_json::Value)],
        master_date_modified: Option<&str>,
    ) -> Result<()> {
        let mut sets = Vec::new();
        let mut values = Vec::<rusqlite::types::Value>::new();
        let mut touches_search = false;
        for (field, value) in fields {
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
            sets.push(format!("{column} = ?"));
            values.push(match value {
                serde_json::Value::Null => rusqlite::types::Value::Null,
                serde_json::Value::String(value) => rusqlite::types::Value::Text(value.clone()),
                serde_json::Value::Bool(value) => {
                    rusqlite::types::Value::Integer(i64::from(*value))
                }
                serde_json::Value::Number(value) => rusqlite::types::Value::Integer(
                    value.as_i64().ok_or(rusqlite::Error::InvalidQuery)?,
                ),
                _ => return Err(rusqlite::Error::InvalidQuery),
            });
            touches_search |= search;
        }
        if fields.is_empty() || sets.is_empty() {
            return Ok(());
        }
        sets.push("date_modified = ?".to_string());
        values.push(
            master_date_modified.map_or(rusqlite::types::Value::Null, |value| {
                rusqlite::types::Value::Text(value.to_string())
            }),
        );
        values.push(rusqlite::types::Value::Text(persistent_id.to_string()));
        self.conn.execute(
            &format!(
                "UPDATE tracks SET {} WHERE persistent_id = ?",
                sets.join(", ")
            ),
            rusqlite::params_from_iter(values),
        )?;
        if touches_search {
            self.conn.execute(
                &format!(
                    "UPDATE tracks SET search_text = {SEARCH_TEXT_EXPR} WHERE persistent_id = ?1"
                ),
                [persistent_id],
            )?;
        }
        Ok(())
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
        db.record_sync_track("AAAABBBBCCCCDD01", source.id, "{}")
            .unwrap();
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
