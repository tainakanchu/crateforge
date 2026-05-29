use rusqlite::{params, Result};

use super::Database;
use crate::itunes_xml::parser::RawTrack;
use crate::models::{GenreTagCount, Track, TrackEdit};

/// 既存 genre 文字列 (空白区切り) に tag を追加。重複は無視。
fn merge_tag(current: &str, tag: &str) -> String {
    let tag = tag.trim();
    if tag.is_empty() {
        return current.to_string();
    }
    let mut tags: Vec<&str> = current.split_whitespace().collect();
    if !tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
        tags.push(tag);
    }
    tags.join(" ")
}

fn remove_tag(current: &str, tag: &str) -> String {
    current
        .split_whitespace()
        .filter(|t| !t.eq_ignore_ascii_case(tag.trim()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// UI 側の sortField → (DB カラム名, テキスト列か).
fn sort_field_to_column(sort_field: &str) -> Option<(&'static str, bool)> {
    match sort_field {
        "name" => Some(("name", true)),
        "artist" => Some(("artist", true)),
        "albumArtist" => Some(("album_artist", true)),
        "album" => Some(("album", true)),
        "genre" => Some(("genre", true)),
        "year" => Some(("year", false)),
        "rating" => Some(("rating", false)),
        "playCount" => Some(("play_count", false)),
        "bpm" => Some(("bpm", false)),
        "trackNumber" => Some(("track_number", false)),
        "totalTimeMs" => Some(("total_time_ms", false)),
        "dateAdded" => Some(("date_added", true)),
        _ => None,
    }
}

/// ORDER BY 句を組み立てる。NULL は常に最後、track_id でタイブレーク。
/// `prefix` は JOIN 時のテーブル別名 ("t." など)。`default` は sort_field が無効な時に丸ごと使う句。
pub(super) fn build_order_by(
    sort_field: Option<&str>,
    sort_order: Option<&str>,
    prefix: &str,
    default: &str,
) -> String {
    let Some((col, is_text)) = sort_field.and_then(sort_field_to_column) else {
        return default.to_string();
    };
    let dir = if matches!(sort_order, Some("desc")) {
        "DESC"
    } else {
        "ASC"
    };
    let collate = if is_text { " COLLATE NOCASE" } else { "" };
    format!(
        "({prefix}{col} IS NULL), {prefix}{col}{collate} {dir}, {prefix}track_id ASC",
        prefix = prefix,
        col = col,
        collate = collate,
        dir = dir,
    )
}

impl Database {
    pub fn begin_import(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            DELETE FROM playlist_tracks;
            DELETE FROM playlists;
            DELETE FROM tracks;
            BEGIN TRANSACTION;
            ",
        )?;
        Ok(())
    }

    pub fn finish_import(&self) -> Result<()> {
        self.conn.execute_batch("COMMIT;")?;
        Ok(())
    }

    pub fn insert_track(
        &self,
        raw: &RawTrack,
        location_path: &str,
        file_exists: bool,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO tracks (track_id, persistent_id, name, artist, album_artist, composer,
             album, genre, year, rating, play_count, skip_count, total_time_ms,
             date_added, date_modified, bpm, comments, location_raw, location_path,
             track_type, disabled, compilation, disc_number, disc_count,
             track_number, track_count, file_exists)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)",
            params![
                raw.get_int("Track ID").unwrap_or(0),
                raw.get_str("Persistent ID"),
                raw.get_str("Name"),
                raw.get_str("Artist"),
                raw.get_str("Album Artist"),
                raw.get_str("Composer"),
                raw.get_str("Album"),
                raw.get_str("Genre"),
                raw.get_int("Year"),
                raw.get_int("Rating"),
                raw.get_int("Play Count").unwrap_or(0),
                raw.get_int("Skip Count").unwrap_or(0),
                raw.get_int("Total Time"),
                raw.get_date("Date Added"),
                raw.get_date("Date Modified"),
                raw.get_int("BPM"),
                raw.get_str("Comments"),
                raw.get_str("Location"),
                location_path,
                raw.get_str("Track Type"),
                raw.get_bool("Disabled") as i32,
                raw.get_bool("Compilation") as i32,
                raw.get_int("Disc Number"),
                raw.get_int("Disc Count"),
                raw.get_int("Track Number"),
                raw.get_int("Track Count"),
                file_exists as i32,
            ],
        )?;
        Ok(())
    }

    /// 新規トラックを挿入し、割り当てられた track_id を返す。
    /// 主に CD リッピング・ファイル取り込みで使用。
    #[allow(clippy::too_many_arguments)]
    pub fn add_imported_track(
        &self,
        name: Option<&str>,
        artist: Option<&str>,
        album_artist: Option<&str>,
        album: Option<&str>,
        genre: Option<&str>,
        year: Option<i64>,
        track_number: Option<i64>,
        track_count: Option<i64>,
        disc_number: Option<i64>,
        disc_count: Option<i64>,
        total_time_ms: Option<i64>,
        location_path: &str,
        location_url: &str,
    ) -> Result<i64> {
        let next_id: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(track_id), 0) + 1 FROM tracks", [], |r| r.get(0))?;

        let persistent_id = format!(
            "{:016X}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0)
                ^ (next_id as u64),
        );
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

        self.conn.execute(
            "INSERT INTO tracks (track_id, persistent_id, name, artist, album_artist, album, genre,
                                 year, track_number, track_count, disc_number, disc_count,
                                 total_time_ms, date_added, location_raw, location_path,
                                 track_type, file_exists)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'File', 1)",
            params![
                next_id,
                persistent_id,
                name,
                artist,
                album_artist,
                album,
                genre,
                year,
                track_number,
                track_count,
                disc_number,
                disc_count,
                total_time_ms,
                now,
                location_url,
                location_path,
            ],
        )?;

        Ok(next_id)
    }

    pub fn get_tracks(
        &self,
        limit: i64,
        offset: i64,
        sort_field: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<Vec<Track>> {
        let order_by = build_order_by(sort_field, sort_order, "", "name COLLATE NOCASE ASC");
        let sql = format!(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists
             FROM tracks ORDER BY {} LIMIT ?1 OFFSET ?2",
            order_by
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], row_to_track)?;
        rows.collect()
    }

    pub fn search_tracks(
        &self,
        query: &str,
        limit: i64,
        offset: i64,
        sort_field: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<Vec<Track>> {
        let pattern = format!("%{}%", query);
        let order_by = build_order_by(sort_field, sort_order, "", "name COLLATE NOCASE ASC");
        let sql = format!(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists
             FROM tracks
             WHERE name LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1
                   OR album_artist LIKE ?1 OR genre LIKE ?1 OR comments LIKE ?1
             ORDER BY {} LIMIT ?2 OFFSET ?3",
            order_by
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![pattern, limit, offset], row_to_track)?;
        rows.collect()
    }

    pub fn get_track_by_track_id(&self, track_id: i64) -> Result<Option<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists
             FROM tracks WHERE track_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![track_id], row_to_track)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn get_all_tracks(&self) -> Result<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists
             FROM tracks ORDER BY track_id ASC",
        )?;
        let rows = stmt.query_map([], row_to_track)?;
        rows.collect()
    }

    /// 編集可能フィールドの部分更新。None のフィールドは触らない。
    #[allow(clippy::too_many_arguments)]
    pub fn update_track(&self, track_id: i64, edits: &TrackEdit) -> Result<()> {
        // We build the SET clause dynamically so unset fields stay untouched.
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();

        macro_rules! set_str {
            ($field:ident, $col:literal) => {
                if let Some(v) = &edits.$field {
                    sets.push(concat!($col, " = ?"));
                    values.push(rusqlite::types::Value::Text(v.clone()));
                }
            };
        }
        macro_rules! set_int_opt {
            ($field:ident, $col:literal) => {
                if let Some(v) = edits.$field {
                    sets.push(concat!($col, " = ?"));
                    values.push(rusqlite::types::Value::Integer(v));
                }
            };
        }
        macro_rules! set_int_clear {
            // For nullable numeric fields: Some(Some(v)) sets, Some(None) clears, None keeps.
            ($field:ident, $col:literal) => {
                if let Some(opt) = &edits.$field {
                    match opt {
                        Some(v) => {
                            sets.push(concat!($col, " = ?"));
                            values.push(rusqlite::types::Value::Integer(*v));
                        }
                        None => {
                            sets.push(concat!($col, " = NULL"));
                        }
                    }
                }
            };
        }

        set_str!(name, "name");
        set_str!(artist, "artist");
        set_str!(album_artist, "album_artist");
        set_str!(composer, "composer");
        set_str!(album, "album");
        set_str!(genre, "genre");
        set_str!(comments, "comments");
        set_int_clear!(year, "year");
        set_int_clear!(bpm, "bpm");
        set_int_opt!(rating, "rating");
        set_int_clear!(track_number, "track_number");
        set_int_clear!(track_count, "track_count");
        set_int_clear!(disc_number, "disc_number");
        set_int_clear!(disc_count, "disc_count");

        if sets.is_empty() {
            return Ok(());
        }

        // Touch date_modified.
        sets.push("date_modified = ?");
        values.push(rusqlite::types::Value::Text(
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        ));

        values.push(rusqlite::types::Value::Integer(track_id));

        let sql = format!("UPDATE tracks SET {} WHERE track_id = ?", sets.join(", "));
        let params = rusqlite::params_from_iter(values);
        self.conn.execute(&sql, params)?;
        Ok(())
    }

    pub fn set_rating(&self, track_id: i64, rating: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET rating = ?1, date_modified = ?2 WHERE track_id = ?3",
            params![
                rating,
                chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                track_id
            ],
        )?;
        Ok(())
    }

    /// genre を空白区切りタグ集合として扱い、tag を追加。重複は無視。
    pub fn add_genre_tag(&self, track_id: i64, tag: &str) -> Result<()> {
        let current: Option<String> = self
            .conn
            .query_row(
                "SELECT genre FROM tracks WHERE track_id = ?1",
                params![track_id],
                |r| r.get(0),
            )
            .ok();

        let new_genre = merge_tag(current.as_deref().unwrap_or(""), tag);
        self.conn.execute(
            "UPDATE tracks SET genre = ?1, date_modified = ?2 WHERE track_id = ?3",
            params![
                new_genre,
                chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                track_id
            ],
        )?;
        Ok(())
    }

    pub fn remove_genre_tag(&self, track_id: i64, tag: &str) -> Result<()> {
        let current: Option<String> = self
            .conn
            .query_row(
                "SELECT genre FROM tracks WHERE track_id = ?1",
                params![track_id],
                |r| r.get(0),
            )
            .ok();

        let new_genre = remove_tag(current.as_deref().unwrap_or(""), tag);
        let new_value: Option<String> = if new_genre.is_empty() {
            None
        } else {
            Some(new_genre)
        };
        self.conn.execute(
            "UPDATE tracks SET genre = ?1, date_modified = ?2 WHERE track_id = ?3",
            params![
                new_value,
                chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                track_id
            ],
        )?;
        Ok(())
    }

    /// DB 中の全 genre 値を空白区切りでバラして頻度順に返す。
    pub fn get_all_genre_tags(&self) -> Result<Vec<GenreTagCount>> {
        let mut stmt = self
            .conn
            .prepare("SELECT genre FROM tracks WHERE genre IS NOT NULL AND genre != ''")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;

        let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for row in rows {
            let g = row?;
            for tag in g.split_whitespace() {
                *counts.entry(tag.to_string()).or_insert(0) += 1;
            }
        }
        let mut out: Vec<GenreTagCount> = counts
            .into_iter()
            .map(|(tag, count)| GenreTagCount { tag, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
        Ok(out)
    }

    pub fn add_recent_track(&self, track_id: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO recent_tracks (track_id) VALUES (?1)",
            params![track_id],
        )?;
        self.conn.execute(
            "DELETE FROM recent_tracks WHERE id NOT IN (SELECT id FROM recent_tracks ORDER BY played_at DESC LIMIT 100)",
            [],
        )?;
        Ok(())
    }

    pub fn get_recent_tracks(&self, limit: i64) -> Result<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.track_id, t.persistent_id, t.name, t.artist, t.album_artist, t.composer,
                    t.album, t.genre, t.year, t.rating, t.play_count, t.skip_count, t.total_time_ms,
                    t.date_added, t.date_modified, t.bpm, t.comments, t.location_raw, t.location_path,
                    t.track_type, t.disabled, t.compilation, t.disc_number, t.disc_count,
                    t.track_number, t.track_count, t.file_exists
             FROM tracks t
             INNER JOIN recent_tracks rt ON t.track_id = rt.track_id
             ORDER BY rt.played_at DESC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], row_to_track)?;
        rows.collect()
    }
}

pub fn row_to_track(row: &rusqlite::Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(0)?,
        track_id: row.get(1)?,
        persistent_id: row.get(2)?,
        name: row.get(3)?,
        artist: row.get(4)?,
        album_artist: row.get(5)?,
        composer: row.get(6)?,
        album: row.get(7)?,
        genre: row.get(8)?,
        year: row.get(9)?,
        rating: row.get(10)?,
        play_count: row.get(11)?,
        skip_count: row.get(12)?,
        total_time_ms: row.get(13)?,
        date_added: row.get(14)?,
        date_modified: row.get(15)?,
        bpm: row.get(16)?,
        comments: row.get(17)?,
        location_raw: row.get(18)?,
        location_path: row.get(19)?,
        track_type: row.get(20)?,
        disabled: row.get::<_, i32>(21)? != 0,
        compilation: row.get::<_, i32>(22)? != 0,
        disc_number: row.get(23)?,
        disc_count: row.get(24)?,
        track_number: row.get(25)?,
        track_count: row.get(26)?,
        file_exists: row.get::<_, i32>(27)? != 0,
    })
}
