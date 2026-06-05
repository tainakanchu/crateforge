use rusqlite::{params, Result};

use super::tracks::row_to_track;
use super::Database;
use crate::itunes_xml::parser::RawPlaylist;
use crate::models::{Playlist, Track};

impl Database {
    pub fn insert_playlist(&self, raw: &RawPlaylist, sort_order: i64) -> Result<()> {
        let playlist_id = raw.get_int("Playlist ID").unwrap_or(0);
        let is_smart =
            raw.get_str("Smart Info").is_some() || raw.get_str("Smart Criteria").is_some();

        let distinguished = raw.get_int("Distinguished Kind");
        let master = raw.get_bool("Master");
        if master || distinguished.is_some() {
            return Ok(());
        }

        self.conn.execute(
            "INSERT OR REPLACE INTO playlists (playlist_id, persistent_id, parent_persistent_id, name, is_folder, is_smart, is_user_created, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
            params![
                playlist_id,
                raw.get_str("Playlist Persistent ID"),
                raw.get_str("Parent Persistent ID"),
                raw.get_str("Name").unwrap_or("Untitled"),
                raw.get_bool("Folder") as i32,
                is_smart as i32,
                sort_order,
            ],
        )?;

        for (idx, track_id) in raw.track_ids.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES (?1, ?2, ?3)",
                params![playlist_id, track_id, idx as i64],
            )?;
        }

        Ok(())
    }

    pub fn get_playlists(&self) -> Result<Vec<Playlist>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.playlist_id, p.persistent_id, p.parent_persistent_id,
                    p.name, p.is_folder, p.is_smart, p.is_user_created,
                    (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.playlist_id) as track_count
             FROM playlists p ORDER BY p.sort_order, p.name",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                playlist_id: row.get(1)?,
                persistent_id: row.get(2)?,
                parent_persistent_id: row.get(3)?,
                name: row.get(4)?,
                is_folder: row.get::<_, i32>(5)? != 0,
                is_smart: row.get::<_, i32>(6)? != 0,
                is_user_created: row.get::<_, i32>(7)? != 0,
                track_count: row.get(8)?,
            })
        })?;

        rows.collect()
    }

    pub fn get_playlist_tracks(
        &self,
        playlist_id: i64,
        limit: i64,
        offset: i64,
        sort_field: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<Vec<Track>> {
        let order_by =
            super::tracks::build_order_by(sort_field, sort_order, "t.", "pt.sort_index ASC");
        let sql = format!(
            "SELECT t.id, t.track_id, t.persistent_id, t.name, t.artist, t.album_artist, t.composer,
                    t.album, t.genre, t.year, t.rating, t.play_count, t.skip_count, t.total_time_ms,
                    t.date_added, t.date_modified, t.bpm, t.comments, t.location_raw, t.location_path,
                    t.track_type, t.disabled, t.compilation, t.disc_number, t.disc_count,
                    t.track_number, t.track_count, t.file_exists, t.last_played
             FROM tracks t
             INNER JOIN playlist_tracks pt ON t.track_id = pt.track_id
             WHERE pt.playlist_id = ?1
             ORDER BY {}
             LIMIT ?2 OFFSET ?3",
            order_by
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![playlist_id, limit, offset], row_to_track)?;
        rows.collect()
    }

    pub fn get_playlist_track_ids(&self, playlist_id: i64) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY sort_index ASC",
        )?;
        let rows = stmt.query_map(params![playlist_id], |row| row.get::<_, i64>(0))?;
        rows.collect()
    }

    fn next_playlist_id(&self) -> Result<i64> {
        let max: Option<i64> = self
            .conn
            .query_row("SELECT MAX(playlist_id) FROM playlists", [], |r| r.get(0))?;
        Ok(max.unwrap_or(0) + 1)
    }

    fn next_persistent_id(&self) -> Result<String> {
        let max: Option<i64> = self
            .conn
            .query_row("SELECT MAX(playlist_id) FROM playlists", [], |r| r.get(0))?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        Ok(format!("{:016X}", ts ^ ((max.unwrap_or(0) as u64) << 32)))
    }

    pub fn create_playlist(
        &self,
        name: &str,
        parent_persistent_id: Option<&str>,
        is_folder: bool,
    ) -> Result<Playlist> {
        let playlist_id = self.next_playlist_id()?;
        let persistent_id = self.next_persistent_id()?;
        let sort_order: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM playlists",
            [],
            |r| r.get(0),
        )?;

        self.conn.execute(
            "INSERT INTO playlists (playlist_id, persistent_id, parent_persistent_id, name, is_folder, is_smart, is_user_created, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6)",
            params![
                playlist_id,
                persistent_id,
                parent_persistent_id,
                name,
                is_folder as i32,
                sort_order,
            ],
        )?;

        Ok(Playlist {
            id: 0,
            playlist_id,
            persistent_id: Some(persistent_id),
            parent_persistent_id: parent_persistent_id.map(String::from),
            name: name.to_string(),
            is_folder,
            is_smart: false,
            is_user_created: true,
            track_count: 0,
        })
    }

    pub fn rename_playlist(&self, playlist_id: i64, name: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE playlists SET name = ?1 WHERE playlist_id = ?2",
            params![name, playlist_id],
        )?;
        Ok(())
    }

    pub fn delete_playlist(&self, playlist_id: i64) -> Result<()> {
        let persistent_id: Option<String> = self
            .conn
            .query_row(
                "SELECT persistent_id FROM playlists WHERE playlist_id = ?1",
                params![playlist_id],
                |r| r.get(0),
            )
            .ok();

        if let Some(pid) = persistent_id {
            self.conn.execute(
                "UPDATE playlists SET parent_persistent_id = NULL WHERE parent_persistent_id = ?1",
                params![pid],
            )?;
        }

        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        self.conn.execute(
            "DELETE FROM playlists WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        Ok(())
    }

    pub fn add_tracks_to_playlist(&self, playlist_id: i64, track_ids: &[i64]) -> Result<usize> {
        let next_index: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        )?;

        let mut added = 0usize;
        for (i, tid) in track_ids.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES (?1, ?2, ?3)",
                params![playlist_id, tid, next_index + i as i64],
            )?;
            added += 1;
        }
        Ok(added)
    }

    pub fn remove_track_from_playlist(&self, playlist_id: i64, track_id: i64) -> Result<()> {
        // 同一トラックが複数回入っている場合は最小 sort_index の 1 行のみ削除し、後ろを詰める。
        let sort_index: Option<i64> = self
            .conn
            .query_row(
                "SELECT MIN(sort_index) FROM playlist_tracks
                 WHERE playlist_id = ?1 AND track_id = ?2",
                params![playlist_id, track_id],
                |row| row.get(0),
            )
            .ok();
        let Some(sort_index) = sort_index else {
            return Ok(());
        };
        self.conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND sort_index = ?2",
            params![playlist_id, sort_index],
        )?;
        self.conn.execute(
            "UPDATE playlist_tracks SET sort_index = sort_index - 1
             WHERE playlist_id = ?1 AND sort_index > ?2",
            params![playlist_id, sort_index],
        )?;
        Ok(())
    }

    /// 指定名のルートフォルダ (parent_persistent_id IS NULL) とその子孫を全削除。
    /// 該当フォルダが存在しなければ false を返す (no-op)。プレイリストルールの
    /// `removeExistingNamespace` 用。
    pub fn delete_playlist_subtree_by_root_name(&self, root_name: &str) -> Result<bool> {
        use std::collections::VecDeque;

        let root: Option<(i64, Option<String>)> = self
            .conn
            .query_row(
                "SELECT playlist_id, persistent_id FROM playlists
                 WHERE parent_persistent_id IS NULL AND name = ?1 AND is_folder = 1",
                rusqlite::params![root_name],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .ok();

        let Some((root_id, root_pid)) = root else {
            return Ok(false);
        };

        let mut to_delete: Vec<i64> = vec![root_id];
        let mut queue: VecDeque<String> = VecDeque::new();
        if let Some(pid) = root_pid {
            queue.push_back(pid);
        }

        while let Some(pid) = queue.pop_front() {
            let mut stmt = self.conn.prepare(
                "SELECT playlist_id, persistent_id FROM playlists WHERE parent_persistent_id = ?1",
            )?;
            let rows = stmt.query_map(rusqlite::params![pid], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            for row in rows {
                let (id, pid_opt) = row?;
                to_delete.push(id);
                if let Some(p) = pid_opt {
                    queue.push_back(p);
                }
            }
        }

        let tx = self.conn.unchecked_transaction()?;
        for id in &to_delete {
            tx.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
                rusqlite::params![id],
            )?;
            tx.execute(
                "DELETE FROM playlists WHERE playlist_id = ?1",
                rusqlite::params![id],
            )?;
        }
        tx.commit()?;

        Ok(true)
    }

    pub fn reorder_playlist_tracks(
        &self,
        playlist_id: i64,
        ordered_track_ids: &[i64],
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        for (i, tid) in ordered_track_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES (?1, ?2, ?3)",
                params![playlist_id, tid, i as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回帰防止: row_to_track を共有する全 SELECT の列が一致していること。
    /// get_playlist_tracks の SELECT に last_played が欠けていると、row.get(28) が
    /// InvalidColumnIndex で失敗し、プレイリスト選択時に絞り込みが効かなくなる。
    #[test]
    fn track_selects_match_row_mapper_columns() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, artist, file_exists) VALUES (1, 'Song', 'A', 1)",
                [],
            )
            .unwrap();
        db.conn
            .execute("INSERT INTO playlists (playlist_id, name) VALUES (10, 'P')", [])
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES (10, 1, 0)",
                [],
            )
            .unwrap();

        let in_playlist = db.get_playlist_tracks(10, 100, 0, None, None).unwrap();
        assert_eq!(in_playlist.len(), 1);
        assert_eq!(in_playlist[0].track_id, 1);

        // 同じ row_to_track を使う他経路も一緒に守る。
        assert_eq!(db.get_tracks(100, 0, None, None).unwrap().len(), 1);
        assert_eq!(db.search_tracks("Song", 100, 0, None, None).unwrap().len(), 1);
    }
}
