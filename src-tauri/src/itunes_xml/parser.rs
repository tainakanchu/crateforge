use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use percent_encoding::percent_decode_str;
use quick_xml::events::Event;
use quick_xml::reader::Reader;

use crate::db::Database;

#[derive(Debug, Default)]
pub struct RawTrack {
    pub fields: HashMap<String, PlistValue>,
}

#[derive(Debug, Clone)]
pub enum PlistValue {
    Str(String),
    Int(i64),
    Bool(bool),
    Date(String),
    #[allow(dead_code)]
    Data(String),
}

#[derive(Debug, Default)]
pub struct RawPlaylist {
    pub fields: HashMap<String, PlistValue>,
    pub track_ids: Vec<i64>,
}

pub fn import_library(xml_path: &str, db: &Database) -> Result<(usize, usize, usize), String> {
    let content =
        fs::read_to_string(xml_path).map_err(|e| format!("Failed to read XML file: {}", e))?;

    let (tracks, playlists) = parse_itunes_xml(&content)?;

    let mut missing_files = 0;
    let mut track_id_map = HashMap::new();
    let mut imported_track_persistent_ids = HashSet::new();
    let mut claimed_track_ids = HashSet::new();
    db.begin_import().map_err(|e| e.to_string())?;

    for track in &tracks {
        let location_raw = track
            .fields
            .get("Location")
            .and_then(|v| match v {
                PlistValue::Str(s) => Some(s.as_str()),
                _ => None,
            })
            .unwrap_or("");

        let location_path = resolve_file_url(location_raw);
        let file_exists = if location_path.is_empty() {
            false
        } else {
            Path::new(&location_path).exists()
        };
        if !file_exists && !location_raw.is_empty() {
            missing_files += 1;
        }

        let db_track_id = db
            .insert_track(
                track,
                &location_path,
                file_exists,
                &mut imported_track_persistent_ids,
                &mut claimed_track_ids,
            )
            .map_err(|e| e.to_string())?;
        track_id_map.insert(track.get_int("Track ID").unwrap_or(0), db_track_id);
    }

    let mut imported_playlist_persistent_ids = HashSet::new();
    let mut claimed_playlist_ids = HashSet::new();
    for (idx, playlist) in playlists.iter().enumerate() {
        db.insert_playlist(
            playlist,
            idx as i64,
            &track_id_map,
            &mut imported_playlist_persistent_ids,
            &mut claimed_playlist_ids,
        )
        .map_err(|e| e.to_string())?;
    }

    db.finish_import().map_err(|e| e.to_string())?;

    Ok((tracks.len(), playlists.len(), missing_files))
}

pub fn resolve_file_url(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }

    let decoded = percent_decode_str(url).decode_utf8_lossy().to_string();

    let path = if decoded.starts_with("file://localhost/") {
        &decoded["file://localhost".len()..]
    } else if decoded.starts_with("file:///") {
        &decoded["file://".len()..]
    } else if decoded.starts_with("file://") {
        &decoded["file://".len()..]
    } else {
        return decoded;
    };

    #[cfg(target_os = "windows")]
    {
        if path.len() >= 3 && path.as_bytes()[0] == b'/' && path.as_bytes()[2] == b':' {
            return path[1..].replace('/', "\\");
        }
        return path.replace('/', "\\");
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.to_string()
    }
}

fn parse_itunes_xml(content: &str) -> Result<(Vec<RawTrack>, Vec<RawPlaylist>), String> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut tracks = Vec::new();
    let mut playlists = Vec::new();

    let mut depth = 0;
    let mut current_key = String::new();

    enum State {
        TopLevel,
        InTracksDict,
        InSingleTrack,
        InPlaylistsArray,
        InSinglePlaylist,
        InPlaylistItems,
    }

    let mut state = State::TopLevel;
    let mut current_track = RawTrack::default();
    let mut current_playlist = RawPlaylist::default();
    let mut track_key = String::new();
    let mut playlist_key = String::new();
    let mut text_buf = String::new();
    let mut pending_value_type: Option<String> = None;
    let mut skip_depth: i32 = 0;
    let mut skipping = false;

    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(Event::Start(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();

                if skipping {
                    skip_depth += 1;
                    continue;
                }

                match state {
                    State::TopLevel => {
                        if tag == "key" {
                            text_buf.clear();
                        } else if tag == "dict" {
                            depth += 1;
                            if depth == 2 && current_key == "Tracks" {
                                state = State::InTracksDict;
                            }
                        } else if tag == "array" && current_key == "Playlists" {
                            state = State::InPlaylistsArray;
                        }
                    }
                    State::InTracksDict => {
                        if tag == "key" {
                            text_buf.clear();
                        } else if tag == "dict" {
                            state = State::InSingleTrack;
                            current_track = RawTrack::default();
                        }
                    }
                    State::InSingleTrack => {
                        if tag == "key" {
                            text_buf.clear();
                        } else if tag == "dict" || tag == "array" {
                            skipping = true;
                            skip_depth = 1;
                        } else {
                            text_buf.clear();
                            pending_value_type = Some(tag.clone());
                        }
                    }
                    State::InPlaylistsArray => {
                        if tag == "dict" {
                            state = State::InSinglePlaylist;
                            current_playlist = RawPlaylist::default();
                        }
                    }
                    State::InSinglePlaylist => {
                        if tag == "key" {
                            text_buf.clear();
                        } else if tag == "array" && playlist_key == "Playlist Items" {
                            state = State::InPlaylistItems;
                        } else if tag == "dict" || tag == "array" {
                            skipping = true;
                            skip_depth = 1;
                        } else {
                            text_buf.clear();
                            pending_value_type = Some(tag);
                        }
                    }
                    State::InPlaylistItems => {
                        if tag == "dict" {
                        } else if tag == "key" {
                            text_buf.clear();
                        } else {
                            text_buf.clear();
                            pending_value_type = Some(tag);
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();

                if skipping {
                    skip_depth -= 1;
                    if skip_depth <= 0 {
                        skipping = false;
                    }
                    continue;
                }

                match state {
                    State::TopLevel => {
                        if tag == "key" {
                            current_key = text_buf.clone();
                        }
                    }
                    State::InTracksDict => {
                        if tag == "dict" {
                            state = State::TopLevel;
                        }
                    }
                    State::InSingleTrack => {
                        if tag == "key" {
                            track_key = text_buf.clone();
                        } else if tag == "dict" {
                            tracks.push(std::mem::take(&mut current_track));
                            state = State::InTracksDict;
                        } else if let Some(vtype) = pending_value_type.take() {
                            let val = match vtype.as_str() {
                                "string" => PlistValue::Str(text_buf.clone()),
                                "integer" => PlistValue::Int(text_buf.parse().unwrap_or(0)),
                                "date" => PlistValue::Date(text_buf.clone()),
                                "data" => PlistValue::Data(text_buf.clone()),
                                _ => PlistValue::Str(text_buf.clone()),
                            };
                            current_track.fields.insert(track_key.clone(), val);
                        }
                    }
                    State::InPlaylistsArray => {
                        if tag == "array" {
                            state = State::TopLevel;
                        }
                    }
                    State::InSinglePlaylist => {
                        if tag == "key" {
                            playlist_key = text_buf.clone();
                        } else if tag == "dict" {
                            playlists.push(std::mem::take(&mut current_playlist));
                            state = State::InPlaylistsArray;
                        } else if let Some(vtype) = pending_value_type.take() {
                            let val = match vtype.as_str() {
                                "string" => PlistValue::Str(text_buf.clone()),
                                "integer" => PlistValue::Int(text_buf.parse().unwrap_or(0)),
                                "date" => PlistValue::Date(text_buf.clone()),
                                "data" => PlistValue::Data(text_buf.clone()),
                                _ => PlistValue::Str(text_buf.clone()),
                            };
                            current_playlist.fields.insert(playlist_key.clone(), val);
                        }
                    }
                    State::InPlaylistItems => {
                        if tag == "array" {
                            state = State::InSinglePlaylist;
                        } else if tag == "key" {
                        } else if pending_value_type.take().is_some() {
                            if let Ok(tid) = text_buf.parse::<i64>() {
                                current_playlist.track_ids.push(tid);
                            }
                        }
                    }
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if skipping {
                    continue;
                }
                match state {
                    State::InSingleTrack => {
                        if tag == "true" || tag == "false" {
                            current_track
                                .fields
                                .insert(track_key.clone(), PlistValue::Bool(tag == "true"));
                        }
                    }
                    State::InSinglePlaylist => {
                        if tag == "true" || tag == "false" {
                            current_playlist
                                .fields
                                .insert(playlist_key.clone(), PlistValue::Bool(tag == "true"));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                if !skipping {
                    text_buf = e.unescape().unwrap_or_default().to_string();
                }
            }
            Err(e) => return Err(format!("XML parse error: {}", e)),
            _ => {}
        }
    }

    Ok((tracks, playlists))
}

impl RawTrack {
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(|v| match v {
            PlistValue::Str(s) => Some(s.as_str()),
            _ => None,
        })
    }

    pub fn get_int(&self, key: &str) -> Option<i64> {
        self.fields.get(key).and_then(|v| match v {
            PlistValue::Int(i) => Some(*i),
            _ => None,
        })
    }

    pub fn get_bool(&self, key: &str) -> bool {
        self.fields
            .get(key)
            .and_then(|v| match v {
                PlistValue::Bool(b) => Some(*b),
                _ => None,
            })
            .unwrap_or(false)
    }

    pub fn get_date(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(|v| match v {
            PlistValue::Date(s) => Some(s.as_str()),
            _ => None,
        })
    }
}

impl RawPlaylist {
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(|v| match v {
            PlistValue::Str(s) => Some(s.as_str()),
            _ => None,
        })
    }

    pub fn get_int(&self, key: &str) -> Option<i64> {
        self.fields.get(key).and_then(|v| match v {
            PlistValue::Int(i) => Some(*i),
            _ => None,
        })
    }

    pub fn get_bool(&self, key: &str) -> bool {
        self.fields
            .get(key)
            .and_then(|v| match v {
                PlistValue::Bool(b) => Some(*b),
                _ => None,
            })
            .unwrap_or(false)
    }
}
