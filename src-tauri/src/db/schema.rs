use rusqlite::{Connection, Result};

pub fn create_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            track_id INTEGER NOT NULL UNIQUE,
            persistent_id TEXT,
            name TEXT,
            artist TEXT,
            album_artist TEXT,
            composer TEXT,
            album TEXT,
            genre TEXT,
            year INTEGER,
            rating INTEGER,
            play_count INTEGER DEFAULT 0,
            skip_count INTEGER DEFAULT 0,
            total_time_ms INTEGER,
            date_added TEXT,
            date_modified TEXT,
            bpm INTEGER,
            comments TEXT,
            location_raw TEXT,
            location_path TEXT,
            track_type TEXT,
            disabled INTEGER DEFAULT 0,
            compilation INTEGER DEFAULT 0,
            disc_number INTEGER,
            disc_count INTEGER,
            track_number INTEGER,
            track_count INTEGER,
            file_exists INTEGER DEFAULT 1,
            last_played TEXT,
            search_text TEXT
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER NOT NULL UNIQUE,
            persistent_id TEXT,
            parent_persistent_id TEXT,
            name TEXT NOT NULL,
            is_folder INTEGER DEFAULT 0,
            is_smart INTEGER DEFAULT 0,
            is_user_created INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            smart_criteria TEXT
        );

        CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id INTEGER NOT NULL,
            track_id INTEGER NOT NULL,
            sort_index INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS recent_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            track_id INTEGER NOT NULL,
            played_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS track_analysis (
            track_id INTEGER PRIMARY KEY,
            version INTEGER NOT NULL,
            analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
            bpm REAL,
            key_camelot TEXT,
            key_name TEXT,
            energy REAL,
            loudness_lufs REAL,
            replaygain_db REAL,
            vector TEXT,
            peaks TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tracks_name ON tracks(name);
        CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
        CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
        CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
        CREATE INDEX IF NOT EXISTS idx_tracks_track_id ON tracks(track_id);
        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pid ON playlist_tracks(playlist_id);
        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_tid ON playlist_tracks(track_id);
        CREATE INDEX IF NOT EXISTS idx_recent_tracks_at ON recent_tracks(played_at);
        CREATE INDEX IF NOT EXISTS idx_analysis_bpm ON track_analysis(bpm);
        CREATE INDEX IF NOT EXISTS idx_analysis_key ON track_analysis(key_camelot);
        ",
    )?;
    Ok(())
}
