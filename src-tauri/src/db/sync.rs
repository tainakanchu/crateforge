//! federation slave 側の同期用 DB 操作。

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

    /// sync_track 記録と、現在のローカルファイルの場所を返す。
    pub fn synced_track_state(&self, persistent_id: &str) -> Result<(bool, Option<String>)> {
        let recorded: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_track WHERE persistent_id = ?1)",
            [persistent_id],
            |row| row.get(0),
        )?;
        let path = self
            .conn
            .query_row(
                "SELECT location_path FROM tracks WHERE persistent_id = ?1",
                [persistent_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok((recorded, path))
    }

    /// master DTO を正としてメタデータを更新し、ローカルの persistent_id を維持する。
    /// 既存行では track_id を変えず、新規行だけ MAX+1 を割り当てる。
    pub fn upsert_synced_track(&self, track: &Track, path: &Path) -> Result<i64> {
        let persistent_id = track
            .persistent_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let location_path = path.to_string_lossy().to_string();
        let location_raw = url::Url::from_file_path(path)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| format!("file://{location_path}"));

        if let Some(track_id) = self
            .conn
            .query_row(
                "SELECT track_id FROM tracks WHERE persistent_id = ?1",
                [persistent_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
        {
            self.update_synced_track(track_id, track, &location_raw, &location_path)?;
            return Ok(track_id);
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
                    return Ok(track_id);
                }
                Err(err) if super::should_retry_constraint(&err, attempt) => {
                    if let Some(existing_id) = self
                        .conn
                        .query_row(
                            "SELECT track_id FROM tracks WHERE persistent_id = ?1",
                            [persistent_id],
                            |row| row.get::<_, i64>(0),
                        )
                        .optional()?
                    {
                        self.update_synced_track(
                            existing_id,
                            track,
                            &location_raw,
                            &location_path,
                        )?;
                        return Ok(existing_id);
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

    /// master playlist の persistent_id を保ち、所属曲を master 順で全置換する。
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
                "UPDATE playlists SET parent_persistent_id=?1, name=?2, is_folder=?3,
                     is_smart=?4, is_user_created=0 WHERE playlist_id=?5",
                params![
                    playlist.parent_persistent_id,
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
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
                params![
                    playlist_id,
                    persistent_id,
                    playlist.parent_persistent_id,
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
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name) VALUES (41, 'OTHERPID00000001', 'Other')",
                [],
            )
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.mp3");
        std::fs::write(&path, b"audio").unwrap();

        let first = db
            .upsert_synced_track(&track("MASTERPID0000001", "First", 80), &path)
            .unwrap();
        assert_eq!(first, 42);
        let second = db
            .upsert_synced_track(&track("MASTERPID0000001", "Refreshed", 100), &path)
            .unwrap();
        assert_eq!(second, first);

        let stored = db
            .get_tracks_by_persistent_ids(&["MASTERPID0000001".to_string()])
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(stored.persistent_id.as_deref(), Some("MASTERPID0000001"));
        assert_eq!(stored.name.as_deref(), Some("Refreshed"));
        assert_eq!(stored.rating, Some(100));
        assert_eq!(stored.play_count, Some(7));
        assert_eq!(stored.location_path.as_deref(), path.to_str());

        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE persistent_id='MASTERPID0000001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn synced_playlist_keeps_pid_and_replaces_membership() {
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
            persistent_id: Some("MASTERPLAYLIST01".to_string()),
            parent_persistent_id: None,
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
        let pid: String = db
            .conn
            .query_row(
                "SELECT persistent_id FROM playlists WHERE playlist_id=?1",
                [first],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pid, "MASTERPLAYLIST01");
    }
}
