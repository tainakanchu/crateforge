//! 条件 DSL の評価。
//!
//! 仕様: <https://github.com/tainakanchu/itunes-playlist-builder/blob/master/doc.md#14-condition-dsl>

use crate::models::Track;

use super::registry::PlaylistRegistry;
use super::schema::{BuildOptions, Condition, FieldCondition, PlaylistRef};

pub enum FieldValue<'a> {
    Str(&'a str),
    Int(i64),
    Bool(bool),
}

impl<'a> FieldValue<'a> {
    fn as_number(&self) -> Option<f64> {
        match self {
            FieldValue::Int(n) => Some(*n as f64),
            FieldValue::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            FieldValue::Str(s) => s.parse::<f64>().ok(),
        }
    }

    fn as_display_string(&self) -> String {
        match self {
            FieldValue::Str(s) => (*s).to_string(),
            FieldValue::Int(n) => n.to_string(),
            FieldValue::Bool(b) => b.to_string(),
        }
    }
}

pub fn get_field<'a>(track: &'a Track, field: &str) -> Option<FieldValue<'a>> {
    match field {
        "trackId" => Some(FieldValue::Int(track.track_id)),
        "name" => track.name.as_deref().map(FieldValue::Str),
        "artist" => track.artist.as_deref().map(FieldValue::Str),
        "albumArtist" => track.album_artist.as_deref().map(FieldValue::Str),
        "composer" => track.composer.as_deref().map(FieldValue::Str),
        "album" => track.album.as_deref().map(FieldValue::Str),
        "genre" => track.genre.as_deref().map(FieldValue::Str),
        "bpm" => track.bpm.map(FieldValue::Int),
        "rating" => track.rating.map(FieldValue::Int),
        "playCount" => track.play_count.map(FieldValue::Int),
        "skipCount" => track.skip_count.map(FieldValue::Int),
        "year" => track.year.map(FieldValue::Int),
        "trackNumber" => track.track_number.map(FieldValue::Int),
        "discNumber" => track.disc_number.map(FieldValue::Int),
        "dateAdded" => track.date_added.as_deref().map(FieldValue::Str),
        "dateModified" => track.date_modified.as_deref().map(FieldValue::Str),
        "location" => track
            .location_path
            .as_deref()
            .or(track.location_raw.as_deref())
            .map(FieldValue::Str),
        "comments" => track.comments.as_deref().map(FieldValue::Str),
        "compilation" => Some(FieldValue::Bool(track.compilation)),
        "disabled" => Some(FieldValue::Bool(track.disabled)),
        "kind" => track.track_type.as_deref().map(FieldValue::Str),
        // `grouping` / `podcast` are part of the spec but not stored in this app's Track yet.
        // Treat them as absent so `exists: false` is true.
        "grouping" | "podcast" => None,
        _ => None,
    }
}

pub fn evaluate(
    track: &Track,
    condition: &Condition,
    options: &BuildOptions,
    registry: &PlaylistRegistry,
) -> bool {
    match condition {
        Condition::All { all } => all.iter().all(|c| evaluate(track, c, options, registry)),
        Condition::Any { any } => any.iter().any(|c| evaluate(track, c, options, registry)),
        Condition::Not { not } => !evaluate(track, not, options, registry),
        Condition::InPlaylist { in_playlist } => evaluate_in_playlist(track, in_playlist, registry),
        Condition::Field(c) => evaluate_field(track, c, options),
    }
}

fn evaluate_in_playlist(track: &Track, r: &PlaylistRef, registry: &PlaylistRegistry) -> bool {
    match registry.resolve(r) {
        Some(set) => set.contains(&track.track_id),
        None => false,
    }
}

fn evaluate_field(track: &Track, c: &FieldCondition, opts: &BuildOptions) -> bool {
    let value = get_field(track, &c.field);

    // exists takes precedence — has no left-hand value requirement.
    if let Some(should_exist) = c.exists {
        return should_exist == value.is_some();
    }

    let Some(value) = value else {
        return false;
    };

    if let Some(expected) = &c.equals {
        return yaml_equals(&value, expected, opts.case_sensitive_contains);
    }

    if let Some(needle) = &c.contains {
        let haystack = value.as_display_string();
        return string_contains(&haystack, needle, opts.case_sensitive_contains);
    }

    if let Some(list) = &c.in_ {
        return list
            .iter()
            .any(|item| yaml_equals(&value, item, opts.case_sensitive_contains));
    }

    if let Some(gt) = c.gt {
        return value.as_number().is_some_and(|n| n > gt);
    }
    if let Some(gte) = c.gte {
        return value.as_number().is_some_and(|n| n >= gte);
    }
    if let Some(lt) = c.lt {
        return value.as_number().is_some_and(|n| n < lt);
    }
    if let Some(lte) = c.lte {
        return value.as_number().is_some_and(|n| n <= lte);
    }

    false
}

fn yaml_equals(value: &FieldValue, expected: &serde_yaml::Value, case_sensitive: bool) -> bool {
    match (value, expected) {
        (FieldValue::Str(s), serde_yaml::Value::String(t)) => compare_strings(s, t, case_sensitive),
        (FieldValue::Int(n), serde_yaml::Value::Number(num)) => {
            num.as_i64().map(|v| v == *n).unwrap_or(false)
                || num.as_f64().map(|v| v == *n as f64).unwrap_or(false)
        }
        (FieldValue::Bool(b), serde_yaml::Value::Bool(t)) => b == t,
        _ => false,
    }
}

fn compare_strings(a: &str, b: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        a == b
    } else {
        a.to_lowercase() == b.to_lowercase()
    }
}

fn string_contains(haystack: &str, needle: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        haystack.contains(needle)
    } else {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    }
}
