use std::fs;
use std::io::Write;
use std::path::Path;

use crate::db::Database;
use crate::models::{ExportResult, Playlist, Track};

pub fn export_library(db: &Database, output_path: &str) -> Result<ExportResult, String> {
    // スナップショット: WAL の repeatable-read でトラック/プレイリスト読み取りを一貫させる。
    let snapshot = db.read_txn().map_err(|e| e.to_string())?;
    let tracks = db.get_all_tracks().map_err(|e| e.to_string())?;
    let playlists = db.get_playlists().map_err(|e| e.to_string())?;

    let mut buf = String::with_capacity(1024 * 1024);
    buf.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    buf.push('\n');
    buf.push_str(r#"<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#);
    buf.push('\n');
    buf.push_str(r#"<plist version="1.0">"#);
    buf.push('\n');
    buf.push_str("<dict>\n");

    push_kv_int(&mut buf, 1, "Major Version", 1);
    push_kv_int(&mut buf, 1, "Minor Version", 1);
    push_kv_date(&mut buf, 1, "Date", &current_iso8601());
    push_kv_str(&mut buf, 1, "Application Version", "12.13.5.5");
    push_kv_int(&mut buf, 1, "Features", 5);
    push_kv_bool(&mut buf, 1, "Show Content Ratings", true);
    push_kv_str(
        &mut buf,
        1,
        "Library Persistent ID",
        &generate_persistent_id(),
    );

    push_indent(&mut buf, 1);
    buf.push_str("<key>Tracks</key>\n");
    push_indent(&mut buf, 1);
    buf.push_str("<dict>\n");
    for track in &tracks {
        write_track(&mut buf, track, 2);
    }
    push_indent(&mut buf, 1);
    buf.push_str("</dict>\n");

    push_indent(&mut buf, 1);
    buf.push_str("<key>Playlists</key>\n");
    push_indent(&mut buf, 1);
    buf.push_str("<array>\n");
    for playlist in &playlists {
        write_playlist(&mut buf, db, playlist, 2)?;
    }
    push_indent(&mut buf, 1);
    buf.push_str("</array>\n");

    buf.push_str("</dict>\n");
    buf.push_str("</plist>\n");

    // スナップショットはここで解放 (ファイル I/O 中は保持しない)。
    drop(snapshot);

    // アトミック書き込み: tmp に書いてから rename で置換 (クラッシュ時の破損を防ぐ)。
    let output_path_obj = Path::new(output_path);
    let parent = output_path_obj.parent().unwrap_or_else(|| Path::new("."));
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let tmp = parent.join(format!("crateforge-{}-{}.tmp", pid, nanos));

    let write_result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create tmp file: {}", e))?;
        file.write_all(buf.as_bytes())
            .map_err(|e| format!("Failed to write tmp file: {}", e))?;
        file.flush()
            .map_err(|e| format!("Failed to flush tmp file: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync tmp file: {}", e))?;
        drop(file);
        fs::rename(&tmp, output_path)
            .map_err(|e| format!("Failed to rename tmp file: {}", e))?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp); // 孤児 tmp を削除して既存ファイルを温存。
        return Err(e);
    }

    Ok(ExportResult {
        output_path: output_path.to_string(),
        track_count: tracks.len(),
        playlist_count: playlists.len(),
    })
}

fn write_track(buf: &mut String, t: &Track, indent: usize) {
    push_indent(buf, indent);
    buf.push_str(&format!("<key>{}</key>\n", t.track_id));
    push_indent(buf, indent);
    buf.push_str("<dict>\n");

    let inner = indent + 1;
    push_kv_int(buf, inner, "Track ID", t.track_id);
    if let Some(ref s) = t.persistent_id {
        push_kv_str(buf, inner, "Persistent ID", s);
    }
    if let Some(ref s) = t.name {
        push_kv_str(buf, inner, "Name", s);
    }
    if let Some(ref s) = t.artist {
        push_kv_str(buf, inner, "Artist", s);
    }
    if let Some(ref s) = t.album_artist {
        push_kv_str(buf, inner, "Album Artist", s);
    }
    if let Some(ref s) = t.composer {
        push_kv_str(buf, inner, "Composer", s);
    }
    if let Some(ref s) = t.album {
        push_kv_str(buf, inner, "Album", s);
    }
    if let Some(ref s) = t.genre {
        push_kv_str(buf, inner, "Genre", s);
    }
    if let Some(n) = t.year {
        push_kv_int(buf, inner, "Year", n);
    }
    if let Some(n) = t.bpm {
        push_kv_int(buf, inner, "BPM", n);
    }
    if let Some(n) = t.disc_number {
        push_kv_int(buf, inner, "Disc Number", n);
    }
    if let Some(n) = t.disc_count {
        push_kv_int(buf, inner, "Disc Count", n);
    }
    if let Some(n) = t.track_number {
        push_kv_int(buf, inner, "Track Number", n);
    }
    if let Some(n) = t.track_count {
        push_kv_int(buf, inner, "Track Count", n);
    }
    if let Some(n) = t.rating {
        push_kv_int(buf, inner, "Rating", n);
    }
    if let Some(n) = t.play_count {
        if n > 0 {
            push_kv_int(buf, inner, "Play Count", n);
        }
    }
    if let Some(n) = t.skip_count {
        if n > 0 {
            push_kv_int(buf, inner, "Skip Count", n);
        }
    }
    if let Some(n) = t.total_time_ms {
        push_kv_int(buf, inner, "Total Time", n);
    }
    if let Some(ref s) = t.date_added {
        push_kv_date(buf, inner, "Date Added", s);
    }
    if let Some(ref s) = t.date_modified {
        push_kv_date(buf, inner, "Date Modified", s);
    }
    if let Some(ref s) = t.comments {
        push_kv_str(buf, inner, "Comments", s);
    }
    if let Some(ref s) = t.track_type {
        push_kv_str(buf, inner, "Track Type", s);
    }
    if t.compilation {
        push_kv_bool(buf, inner, "Compilation", true);
    }
    if t.disabled {
        push_kv_bool(buf, inner, "Disabled", true);
    }
    if let Some(ref s) = t.location_raw {
        if !s.is_empty() {
            push_kv_str(buf, inner, "Location", s);
        }
    } else if let Some(ref s) = t.location_path {
        if !s.is_empty() {
            push_kv_str(buf, inner, "Location", &path_to_file_url(s));
        }
    }

    push_indent(buf, indent);
    buf.push_str("</dict>\n");
}

fn write_playlist(
    buf: &mut String,
    db: &Database,
    p: &Playlist,
    indent: usize,
) -> Result<(), String> {
    push_indent(buf, indent);
    buf.push_str("<dict>\n");

    let inner = indent + 1;
    push_kv_str(buf, inner, "Name", &p.name);
    if let Some(ref pid) = p.persistent_id {
        push_kv_str(buf, inner, "Playlist Persistent ID", pid);
    }
    push_kv_int(buf, inner, "Playlist ID", p.playlist_id);
    if let Some(ref parent) = p.parent_persistent_id {
        push_kv_str(buf, inner, "Parent Persistent ID", parent);
    }
    push_kv_bool(buf, inner, "All Items", true);
    if p.is_folder {
        push_kv_bool(buf, inner, "Folder", true);
    }

    if !p.is_folder {
        let track_ids = db
            .get_playlist_track_ids(p.playlist_id)
            .map_err(|e| e.to_string())?;
        push_indent(buf, inner);
        buf.push_str("<key>Playlist Items</key>\n");
        push_indent(buf, inner);
        buf.push_str("<array>\n");
        for tid in track_ids {
            push_indent(buf, inner + 1);
            buf.push_str("<dict>\n");
            push_kv_int(buf, inner + 2, "Track ID", tid);
            push_indent(buf, inner + 1);
            buf.push_str("</dict>\n");
        }
        push_indent(buf, inner);
        buf.push_str("</array>\n");
    }

    push_indent(buf, indent);
    buf.push_str("</dict>\n");
    Ok(())
}

// === Helpers ===

fn push_indent(buf: &mut String, level: usize) {
    for _ in 0..level {
        buf.push('\t');
    }
}

fn push_kv_str(buf: &mut String, indent: usize, key: &str, value: &str) {
    push_indent(buf, indent);
    buf.push_str(&format!(
        "<key>{}</key><string>{}</string>\n",
        escape_xml(key),
        escape_xml(value)
    ));
}

fn push_kv_int(buf: &mut String, indent: usize, key: &str, value: i64) {
    push_indent(buf, indent);
    buf.push_str(&format!(
        "<key>{}</key><integer>{}</integer>\n",
        escape_xml(key),
        value
    ));
}

fn push_kv_bool(buf: &mut String, indent: usize, key: &str, value: bool) {
    push_indent(buf, indent);
    buf.push_str(&format!(
        "<key>{}</key><{}/>\n",
        escape_xml(key),
        if value { "true" } else { "false" }
    ));
}

fn push_kv_date(buf: &mut String, indent: usize, key: &str, value: &str) {
    push_indent(buf, indent);
    buf.push_str(&format!(
        "<key>{}</key><date>{}</date>\n",
        escape_xml(key),
        escape_xml(value)
    ));
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&#38;"),
            '<' => out.push_str("&#60;"),
            '>' => out.push_str("&#62;"),
            _ => out.push(c),
        }
    }
    out
}

fn current_iso8601() -> String {
    use chrono::Utc;
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn generate_persistent_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{:016X}", ts)
}

pub fn path_to_file_url(path: &str) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

    const PATH_SAFE: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'<')
        .add(b'>')
        .add(b'`')
        .add(b'?')
        .add(b'#')
        .add(b'%')
        .add(b'{')
        .add(b'}')
        .add(b'|')
        .add(b'\\')
        .add(b'^');

    #[cfg(target_os = "windows")]
    {
        let normalized = path.replace('\\', "/");
        let encoded: String = utf8_percent_encode(&normalized, PATH_SAFE).collect();
        format!("file://localhost/{}", encoded)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let encoded: String = utf8_percent_encode(path, PATH_SAFE).collect();
        format!("file://{}", encoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::fs;

    #[test]
    fn test_export_library_atomic() {
        let db = Database::open_memory().expect("open_memory failed");

        let tmp_dir = tempfile::tempdir().expect("tempdir failed");
        let out_path = tmp_dir.path().join("crateforge.xml");
        let out_str = out_path.to_string_lossy().to_string();

        let result = export_library(&db, &out_str);
        assert!(result.is_ok(), "export_library failed: {:?}", result.err());

        // (1) 出力ファイルが存在し、<plist を含む。
        assert!(out_path.exists(), "output file does not exist");
        let content = fs::read_to_string(&out_path).expect("read output file failed");
        assert!(content.contains("<plist"), "output does not contain <plist");

        // (2) tmp ファイルが残っていない。
        let tmp_files: Vec<_> = fs::read_dir(tmp_dir.path())
            .expect("read_dir failed")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(tmp_files.is_empty(), "orphan .tmp files remain: {:?}", tmp_files);
    }
}
