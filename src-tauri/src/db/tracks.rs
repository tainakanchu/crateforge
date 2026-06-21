use rusqlite::{params, Result};
use serde::Serialize;

use super::Database;
use crate::itunes_xml::parser::RawTrack;
use crate::models::{GenreTagCount, Track, TrackEdit};

/// `/api/albums` で返す、ライブラリ内の distinct なアルバム 1 件分の情報。
/// `sample_track_id` はアートワーク表示用の代表トラック (アルバム内最小 track_id)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumInfo {
    pub album: String,
    pub album_artist: Option<String>,
    pub track_count: i64,
    pub sample_track_id: i64,
}

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
        "lastPlayed" => Some(("last_played", true)),
        _ => None,
    }
}

/// 検索トークンが bpm:/key:/energy: フィルタなら (SQL 句, バインド値) を返す。
/// 句は相関サブクエリで track_analysis を参照する (SELECT 句や JOIN を変えずに済む)。
fn parse_analysis_filter(tok: &str) -> Option<(String, Vec<rusqlite::types::Value>)> {
    use rusqlite::types::Value;
    let (kind, val) = tok.split_once(':')?;
    match kind {
        "bpm" => {
            let (lo, hi) = parse_range(val, 2.0)?;
            Some((
                "(COALESCE((SELECT bpm FROM track_analysis WHERE track_id = tracks.track_id), \
                 tracks.bpm) BETWEEN ? AND ?)"
                    .to_string(),
                vec![Value::Real(lo), Value::Real(hi)],
            ))
        }
        "key" => {
            let k = val.trim().to_uppercase();
            if k.is_empty() {
                return None;
            }
            Some((
                "tracks.track_id IN (SELECT track_id FROM track_analysis WHERE UPPER(key_camelot) = ?)"
                    .to_string(),
                vec![Value::Text(k)],
            ))
        }
        "energy" => {
            let (lo, hi) = parse_energy_range(val)?;
            Some((
                "tracks.track_id IN (SELECT track_id FROM track_analysis WHERE energy BETWEEN ? AND ?)"
                    .to_string(),
                vec![Value::Real(lo), Value::Real(hi)],
            ))
        }
        _ => None,
    }
}

/// "120-128" → (120,128)、"128" → (128-pad, 128+pad)。
fn parse_range(s: &str, pad: f64) -> Option<(f64, f64)> {
    let s = s.trim();
    if let Some((a, b)) = s.split_once('-') {
        let lo: f64 = a.trim().parse().ok()?;
        let hi: f64 = b.trim().parse().ok()?;
        Some((lo.min(hi), lo.max(hi)))
    } else {
        let v: f64 = s.parse().ok()?;
        Some((v - pad, v + pad))
    }
}

/// energy はパーセント(>1)を 0..1 に正規化。範囲 or 単一値(±0.05)。
fn parse_energy_range(s: &str) -> Option<(f64, f64)> {
    let norm = |x: f64| if x > 1.0 { x / 100.0 } else { x };
    let s = s.trim();
    if let Some((a, b)) = s.split_once('-') {
        let lo = norm(a.trim().parse().ok()?);
        let hi = norm(b.trim().parse().ok()?);
        Some((lo.min(hi), lo.max(hi)))
    } else {
        let v = norm(s.parse::<f64>().ok()?);
        Some(((v - 0.05).max(0.0), (v + 0.05).min(1.0)))
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
        let next_id: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(track_id), 0) + 1 FROM tracks",
            [],
            |r| r.get(0),
        )?;

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
                    track_number, track_count, file_exists, last_played
             FROM tracks ORDER BY {} LIMIT ?1 OFFSET ?2",
            order_by
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], row_to_track)?;
        rows.collect()
    }

    /// 空白区切りの各トークンを AND で結合した検索。
    /// 各トークンは name/artist/album/album_artist/genre/comments の
    /// いずれかに部分一致 (OR)、トークン同士は AND。
    pub fn search_tracks(
        &self,
        query: &str,
        limit: i64,
        offset: i64,
        sort_field: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<Vec<Track>> {
        use rusqlite::types::Value;

        const COLS: [&str; 6] = [
            "name",
            "artist",
            "album",
            "album_artist",
            "genre",
            "comments",
        ];
        let order_by = build_order_by(sort_field, sort_order, "", "name COLLATE NOCASE ASC");

        // 検索の字体ゆれ吸収レベル。Off のときは下の分岐で従来と完全に同じ SQL/バインドを使う。
        let level = crate::text_fold::FoldLevel::from_state(
            self.get_state("search_fold_level").ok().flatten().as_deref(),
        );

        // 各トークンを AND 結合。bpm:/key:/energy: は track_analysis への絞り込み、
        // それ以外はテキスト 6 列への部分一致 (OR)。バインド値は句の出現順に積む。
        let mut clauses: Vec<String> = Vec::new();
        let mut bind: Vec<Value> = Vec::new();
        for tok in query.split_whitespace() {
            if let Some((clause, mut binds)) = parse_analysis_filter(tok) {
                clauses.push(clause);
                bind.append(&mut binds);
                continue;
            }
            // Off: 従来どおり `col LIKE ?` に生トークンの `%..%` をバインド。
            // それ以外: 列側を `fold(col, n)` で畳み、パターンも Rust 側で畳んでからバインド。
            let group = if level == crate::text_fold::FoldLevel::Off {
                let pat = format!("%{}%", tok);
                COLS.iter()
                    .map(|c| {
                        bind.push(Value::Text(pat.clone()));
                        format!("{} LIKE ?", c)
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ")
            } else {
                let pat = format!("%{}%", crate::text_fold::fold(tok, level));
                let n = level.as_i64();
                COLS.iter()
                    .map(|c| {
                        bind.push(Value::Text(pat.clone()));
                        format!("fold({}, {}) LIKE ?", c, n)
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ")
            };
            clauses.push(format!("({})", group));
        }
        let where_sql = if clauses.is_empty() {
            "1=1".to_string()
        } else {
            clauses.join(" AND ")
        };
        bind.push(Value::Integer(limit));
        bind.push(Value::Integer(offset));

        let sql = format!(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists, last_played
             FROM tracks
             WHERE {}
             ORDER BY {} LIMIT ? OFFSET ?",
            where_sql, order_by
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(bind.iter()), row_to_track)?;
        rows.collect()
    }

    pub fn get_track_by_track_id(&self, track_id: i64) -> Result<Option<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists, last_played
             FROM tracks WHERE track_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![track_id], row_to_track)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// 指定した track_id 群を、**入力 ID の順序を保って** 解決する。
    /// 見つからない ID はスキップする (Up Next 表示で、フロントの
    /// ロード済みページに無い曲も解決できるようにするためのもの)。
    pub fn get_tracks_by_ids(&self, track_ids: &[i64]) -> Result<Vec<Track>> {
        let mut out = Vec::with_capacity(track_ids.len());
        for &tid in track_ids {
            if let Some(track) = self.get_track_by_track_id(tid)? {
                out.push(track);
            }
        }
        Ok(out)
    }

    pub fn get_all_tracks(&self) -> Result<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists, last_played
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

        if let Some(v) = edits.compilation {
            sets.push("compilation = ?");
            values.push(rusqlite::types::Value::Integer(if v { 1 } else { 0 }));
        }

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

    /// トラックの実ファイル位置を更新する (自動整理でファイルを移動した後)。
    /// `location_path` は解決済み絶対パス、`location_raw` は `file://` URI。
    pub fn set_track_location(&self, track_id: i64, path: &str, url: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET location_path = ?1, location_raw = ?2 WHERE track_id = ?3",
            params![path, url, track_id],
        )?;
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

    /// アプリ内再生で「1回聴いた」と判定されたとき、play_count を +1 し
    /// last_played を現在時刻 (ISO8601 UTC) に更新する。
    pub fn mark_played(&self, track_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET play_count = COALESCE(play_count, 0) + 1, last_played = ?1 WHERE track_id = ?2",
            params![
                chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                track_id
            ],
        )?;
        Ok(())
    }

    /// 曲を十分聴かずにスキップしたとき skip_count を +1 する。
    pub fn mark_skipped(&self, track_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET skip_count = COALESCE(skip_count, 0) + 1 WHERE track_id = ?1",
            params![track_id],
        )?;
        Ok(())
    }

    /// 取り込み時にタグから読んだ BPM を後付けで設定する (既存 add_imported_track は
    /// BPM を扱わないため、挿入後にこのメソッドで埋める)。
    pub fn set_track_bpm(&self, track_id: i64, bpm: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET bpm = ?1 WHERE track_id = ?2",
            params![bpm, track_id],
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

    /// ライブラリ内の distinct なアルバム一覧を album 名 (NOCASE) 昇順で返す。
    /// album が NULL/空 の曲は除外。`sample_track_id` はアルバム内最小 track_id (代表曲)。
    pub fn get_albums(&self) -> Result<Vec<AlbumInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT album, MAX(album_artist), COUNT(*), MIN(track_id) FROM tracks
             WHERE album IS NOT NULL AND album != '' GROUP BY album ORDER BY album COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(AlbumInfo {
                // WHERE 句で album の非 NULL を保証済み。
                album: r.get(0)?,
                album_artist: r.get(1)?,
                track_count: r.get(2)?,
                sample_track_id: r.get(3)?,
            })
        })?;
        rows.collect()
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
                    t.track_number, t.track_count, t.file_exists, t.last_played
             FROM tracks t
             INNER JOIN recent_tracks rt ON t.track_id = rt.track_id
             ORDER BY rt.played_at DESC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], row_to_track)?;
        rows.collect()
    }

    /// 既存トラックの `location_path` から共通の親フォルダ(= ライブラリルート)を推定する。
    /// 実在ファイルのみ対象。曲数が十分にあれば、各アーティスト/アルバムで分岐するため
    /// 共通プレフィックスは音楽ルート(例 `…/iTunes Media/Music`)に収束する。
    /// 推定できない(曲が少ない/共通部が短すぎる)場合は `None`。
    pub fn detect_library_root(&self) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT location_path FROM tracks
             WHERE location_path IS NOT NULL AND location_path != '' AND file_exists = 1",
        )?;
        let paths: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(common_dir_prefix(&paths))
    }
}

/// パス群の最長共通文字プレフィックスを取り、最後のパス区切り(`/` か `\`)で切って
/// 共通ディレクトリを返す。2件未満・共通ディレクトリが短すぎ(<3)・区切り無しは `None`。
/// Windows(`\`)/Unix(`/`) 双方を扱える。
fn common_dir_prefix(paths: &[String]) -> Option<String> {
    let paths: Vec<&String> = paths.iter().filter(|p| !p.is_empty()).collect();
    if paths.len() < 2 {
        return None;
    }
    let mut prefix: String = paths[0].clone();
    for p in &paths[1..] {
        let n = prefix
            .chars()
            .zip(p.chars())
            .take_while(|(a, b)| a == b)
            .count();
        prefix = prefix.chars().take(n).collect();
        if prefix.is_empty() {
            return None;
        }
    }
    let cut = prefix.rfind(['/', '\\'])?;
    let dir = &prefix[..cut];
    if dir.len() < 3 {
        return None;
    }
    Some(dir.to_string())
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
        last_played: row.get(28)?,
    })
}

#[cfg(test)]
mod tests {
    use super::common_dir_prefix;
    use crate::db::Database;

    /// get_albums は album ごとに distinct 集約し、track_count と最小 track_id を返す。
    /// album が NULL/空 の曲は除外し、album 名 (NOCASE) 昇順で並ぶ。
    #[test]
    fn get_albums_groups_by_album() {
        let db = Database::open_memory().unwrap();
        let rows = [
            // (track_id, album, album_artist)
            (10, Some("Beta"), Some("AA1")),
            (11, Some("Beta"), Some("AA1")),
            (12, Some("alpha"), Some("AA2")),
            (13, Some(""), None),  // 空 album → 除外
            (14, None, None),      // NULL album → 除外
        ];
        for (tid, album, aa) in rows {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, album, album_artist, file_exists)
                     VALUES (?1, ?2, ?3, ?4, 1)",
                    rusqlite::params![tid, format!("t{tid}"), album, aa],
                )
                .unwrap();
        }

        let albums = db.get_albums().unwrap();
        // distinct な album は 2 件 ("alpha", "Beta")。NOCASE 昇順なので alpha が先。
        assert_eq!(albums.len(), 2);
        assert_eq!(albums[0].album, "alpha");
        assert_eq!(albums[0].track_count, 1);
        assert_eq!(albums[0].sample_track_id, 12);
        assert_eq!(albums[0].album_artist.as_deref(), Some("AA2"));

        assert_eq!(albums[1].album, "Beta");
        assert_eq!(albums[1].track_count, 2);
        // 同一 album 内の最小 track_id が代表曲。
        assert_eq!(albums[1].sample_track_id, 10);
        assert_eq!(albums[1].album_artist.as_deref(), Some("AA1"));
    }

    #[test]
    fn windows_library_root() {
        let paths = vec![
            r"C:\Users\me\Music\iTunes\iTunes Media\Music\Alpha\A1\01.mp3".to_string(),
            r"C:\Users\me\Music\iTunes\iTunes Media\Music\Beta\B1\02.m4a".to_string(),
            r"C:\Users\me\Music\iTunes\iTunes Media\Music\Gamma\G1\03.flac".to_string(),
        ];
        assert_eq!(
            common_dir_prefix(&paths).as_deref(),
            Some(r"C:\Users\me\Music\iTunes\iTunes Media\Music")
        );
    }

    #[test]
    fn unix_library_root() {
        let paths = vec![
            "/home/me/Music/Artist1/Album/1.flac".to_string(),
            "/home/me/Music/Artist2/Album/2.flac".to_string(),
        ];
        assert_eq!(common_dir_prefix(&paths).as_deref(), Some("/home/me/Music"));
    }

    #[test]
    fn none_when_too_few_or_divergent() {
        assert_eq!(common_dir_prefix(&[]), None);
        assert_eq!(common_dir_prefix(&["/a/b/c.mp3".to_string()]), None); // 1件
        // 異なるドライブ → 共通プレフィックス無し。
        let p = vec!["C:\\x\\1.mp3".to_string(), "D:\\y\\2.mp3".to_string()];
        assert_eq!(common_dir_prefix(&p), None);
    }
}
