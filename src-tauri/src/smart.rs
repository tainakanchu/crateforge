//! スマートプレイリストの条件評価と並び替え。
//!
//! Track のフィールドに加えて解析結果 (Camelot key / energy) も条件に使える。
//! メンバーシップは保存せず、開くたびにライブ評価する。

use std::cmp::Ordering;

use crate::models::{SmartCriteria, SmartOp, SmartRule, Track, TrackAnalysis};

enum FieldVal {
    Str(String),
    Num(f64),
    None,
}

fn os(v: &Option<String>) -> FieldVal {
    match v {
        Some(s) if !s.is_empty() => FieldVal::Str(s.clone()),
        _ => FieldVal::None,
    }
}
fn on(v: Option<i64>) -> FieldVal {
    match v {
        Some(n) => FieldVal::Num(n as f64),
        None => FieldVal::None,
    }
}

/// 条件で使えるフィールド (フロントの選択肢と一致させる)。
fn field_value(t: &Track, a: Option<&TrackAnalysis>, field: &str) -> FieldVal {
    match field {
        "name" => os(&t.name),
        "artist" => os(&t.artist),
        "albumArtist" => os(&t.album_artist),
        "album" => os(&t.album),
        "genre" => os(&t.genre),
        "composer" => os(&t.composer),
        "comments" => os(&t.comments),
        "year" => on(t.year),
        "bpm" => on(t.bpm),
        // rating はスター数 (0-5) で扱う (DB は 0-100)。
        "rating" => on(t.rating.map(|r| r / 20)),
        "playCount" => on(t.play_count),
        "skipCount" => on(t.skip_count),
        "trackNumber" => on(t.track_number),
        "dateAdded" => os(&t.date_added),
        "lastPlayed" => os(&t.last_played),
        "key" | "keyCamelot" => a
            .and_then(|x| x.key_camelot.clone())
            .map(FieldVal::Str)
            .unwrap_or(FieldVal::None),
        "energy" => a
            .and_then(|x| x.energy)
            .map(FieldVal::Num)
            .unwrap_or(FieldVal::None),
        _ => FieldVal::None,
    }
}

fn str_op(s: &str, r: &SmartRule) -> bool {
    let a = s.to_lowercase();
    let b = r.value.to_lowercase();
    match r.op {
        SmartOp::Is => a == b,
        SmartOp::IsNot => a != b,
        SmartOp::Contains => a.contains(&b),
        SmartOp::NotContains => !a.contains(&b),
        // 文字列に数値比較が来たら辞書順で比較する。
        SmartOp::Gt => a > b,
        SmartOp::Lt => a < b,
        SmartOp::Gte => a >= b,
        SmartOp::Lte => a <= b,
        SmartOp::Exists | SmartOp::NotExists => true,
    }
}

fn num_op(n: f64, r: &SmartRule) -> bool {
    let Ok(v) = r.value.trim().parse::<f64>() else {
        return false;
    };
    match r.op {
        SmartOp::Is => (n - v).abs() < f64::EPSILON,
        SmartOp::IsNot => (n - v).abs() >= f64::EPSILON,
        SmartOp::Gt => n > v,
        SmartOp::Lt => n < v,
        SmartOp::Gte => n >= v,
        SmartOp::Lte => n <= v,
        // 数値に contains が来たら文字列化して判定。
        SmartOp::Contains => n.to_string().contains(r.value.trim()),
        SmartOp::NotContains => !n.to_string().contains(r.value.trim()),
        SmartOp::Exists | SmartOp::NotExists => true,
    }
}

fn rule_matches(t: &Track, a: Option<&TrackAnalysis>, r: &SmartRule) -> bool {
    let v = field_value(t, a, &r.field);
    match r.op {
        SmartOp::Exists => !matches!(v, FieldVal::None),
        SmartOp::NotExists => matches!(v, FieldVal::None),
        _ => match v {
            FieldVal::None => false,
            FieldVal::Str(s) => str_op(&s, r),
            FieldVal::Num(n) => num_op(n, r),
        },
    }
}

/// 1 曲が条件に一致するか。ルールが空なら全件一致。
pub fn track_matches(t: &Track, a: Option<&TrackAnalysis>, c: &SmartCriteria) -> bool {
    if c.rules.is_empty() {
        return true;
    }
    if c.match_all {
        c.rules.iter().all(|r| rule_matches(t, a, r))
    } else {
        c.rules.iter().any(|r| rule_matches(t, a, r))
    }
}

fn lower(v: &Option<String>) -> String {
    v.as_deref().unwrap_or("").to_lowercase()
}

/// マッチ済みトラックを指定フィールドで並び替える (NULL/空は末尾)。
pub fn sort_tracks(tracks: &mut [Track], field: &str, desc: bool) {
    tracks.sort_by(|a, b| {
        let ord = match field {
            "artist" => lower(&a.artist).cmp(&lower(&b.artist)),
            "album" => lower(&a.album).cmp(&lower(&b.album)),
            "albumArtist" => lower(&a.album_artist).cmp(&lower(&b.album_artist)),
            "genre" => lower(&a.genre).cmp(&lower(&b.genre)),
            "bpm" => a.bpm.cmp(&b.bpm),
            "rating" => a.rating.cmp(&b.rating),
            "playCount" => a.play_count.cmp(&b.play_count),
            "year" => a.year.cmp(&b.year),
            "totalTimeMs" => a.total_time_ms.cmp(&b.total_time_ms),
            "trackNumber" => a.track_number.cmp(&b.track_number),
            "dateAdded" => a.date_added.cmp(&b.date_added),
            "lastPlayed" => a.last_played.cmp(&b.last_played),
            _ => lower(&a.name).cmp(&lower(&b.name)),
        };
        let ord = if ord == Ordering::Equal {
            a.track_id.cmp(&b.track_id)
        } else {
            ord
        };
        if desc {
            ord.reverse()
        } else {
            ord
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: i64, artist: &str, bpm: Option<i64>, rating: Option<i64>) -> Track {
        Track {
            id,
            track_id: id,
            persistent_id: None,
            name: Some(format!("Song {id}")),
            artist: Some(artist.to_string()),
            album_artist: None,
            composer: None,
            album: None,
            genre: Some("House".to_string()),
            year: Some(2020),
            rating,
            play_count: Some(5),
            skip_count: Some(0),
            total_time_ms: Some(200_000),
            date_added: None,
            date_modified: None,
            bpm,
            comments: None,
            location_raw: None,
            location_path: None,
            track_type: None,
            disabled: false,
            compilation: false,
            disc_number: None,
            disc_count: None,
            track_number: None,
            track_count: None,
            file_exists: true,
            last_played: None,
        }
    }

    fn rule(field: &str, op: SmartOp, value: &str) -> SmartRule {
        SmartRule {
            field: field.to_string(),
            op,
            value: value.to_string(),
        }
    }

    #[test]
    fn match_all_and_any() {
        let t = track(1, "Daft Punk", Some(124), Some(80)); // 80 -> 4 stars
        let all = SmartCriteria {
            match_all: true,
            rules: vec![
                rule("artist", SmartOp::Contains, "daft"),
                rule("bpm", SmartOp::Gte, "120"),
                rule("rating", SmartOp::Gte, "4"),
            ],
            limit: None,
            sort_by: None,
            sort_desc: false,
        };
        assert!(track_matches(&t, None, &all));

        let any = SmartCriteria {
            match_all: false,
            rules: vec![
                rule("artist", SmartOp::Is, "nobody"),
                rule("bpm", SmartOp::Lt, "100"),
                rule("genre", SmartOp::Contains, "house"),
            ],
            limit: None,
            sort_by: None,
            sort_desc: false,
        };
        assert!(track_matches(&t, None, &any)); // genre matches
    }

    #[test]
    fn numeric_and_exists() {
        let t = track(1, "X", None, None);
        assert!(track_matches(
            &t,
            None,
            &SmartCriteria {
                match_all: true,
                rules: vec![rule("bpm", SmartOp::NotExists, "")],
                limit: None,
                sort_by: None,
                sort_desc: false,
            }
        ));
        let t2 = track(2, "X", Some(128), None);
        assert!(!track_matches(
            &t2,
            None,
            &SmartCriteria {
                match_all: true,
                rules: vec![rule("bpm", SmartOp::Lt, "120")],
                limit: None,
                sort_by: None,
                sort_desc: false,
            }
        ));
    }

    #[test]
    fn sort_desc_by_bpm() {
        let mut v = vec![
            track(1, "A", Some(120), None),
            track(2, "B", Some(128), None),
            track(3, "C", Some(124), None),
        ];
        sort_tracks(&mut v, "bpm", true);
        assert_eq!(v.iter().map(|t| t.track_id).collect::<Vec<_>>(), vec![2, 3, 1]);
    }
}
