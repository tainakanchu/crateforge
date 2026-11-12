//! スマートプレイリストの条件評価と並び替え。
//!
//! Track のフィールドに加えて解析結果 (Camelot key / energy) も条件に使える。
//! メンバーシップは保存せず、開くたびにライブ評価する。
//!
//! 「プレイリストに含まれる」条件 (`field = "playlist"`) は、参照先のメンバー集合を
//! 呼び出し側 (DB 層) が事前に解決して [`EvalContext`] に渡す。ここは純粋関数のまま保つ。

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::models::{SmartCriteria, SmartGroup, SmartOp, SmartRule, Track, TrackAnalysis};
use crate::text_fold::{fold, FoldLevel};

/// プレイリスト参照ルールのフィールド名。
pub const PLAYLIST_FIELD: &str = "playlist";

/// 条件評価のコンテキスト。
pub struct EvalContext<'a> {
    /// テキスト比較の字体ゆれ吸収レベル (Off でも大小無視は維持)。
    pub level: FoldLevel,
    /// 参照先プレイリスト (persistent_id) → メンバーの track_id 集合。
    /// 載っていない参照先は「存在しない = 空」として扱う。
    pub membership: &'a HashMap<String, HashSet<i64>>,
}

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

/// 0-100 の rating を 0..5 の星 (0.5 刻み) に丸める。フロントの `ratingToStars` と同じ式。
fn rating_to_stars(r: i64) -> f64 {
    (r.clamp(0, 100) as f64 / 10.0).round() / 2.0
}

/// bool の列は 1 / 0 の数値として扱う (Rules の `equals: true` は `is "1"` に変換される)。
fn ob(v: bool) -> FieldVal {
    FieldVal::Num(if v { 1.0 } else { 0.0 })
}

/// 条件で評価できるフィールド名 ([`field_value`] の分岐と一致させる)。
/// ここに無い名前は常に「値なし」として扱われる。
pub const FIELDS: &[&str] = &[
    "trackId",
    "name",
    "artist",
    "albumArtist",
    "album",
    "genre",
    "grouping",
    "composer",
    "comments",
    "year",
    "bpm",
    "rating",
    "playCount",
    "skipCount",
    "trackNumber",
    "discNumber",
    "dateAdded",
    "dateModified",
    "lastPlayed",
    "location",
    "kind",
    "compilation",
    "disabled",
    "podcast",
    "bitrate",
    "sampleRate",
    "bitDepth",
    "channels",
    "fileSize",
    "codec",
    "key",
    "keyCamelot",
    "energy",
];

/// 並び替えに使えるフィールド名 ([`compare_field`] の分岐と一致させる)。
/// ここに無い名前は name 順になる。
pub const SORT_FIELDS: &[&str] = &[
    "trackId",
    "name",
    "artist",
    "album",
    "albumArtist",
    "genre",
    "grouping",
    "composer",
    "comments",
    "bpm",
    "rating",
    "playCount",
    "skipCount",
    "year",
    "totalTimeMs",
    "trackNumber",
    "discNumber",
    "dateAdded",
    "dateModified",
    "lastPlayed",
    "location",
    "kind",
    "compilation",
    "disabled",
    "podcast",
    "bitrate",
    "sampleRate",
    "bitDepth",
    "channels",
    "fileSize",
    "codec",
];

/// 実効 BPM = タグの BPM ?? 解析 BPM (タグ優先)。一覧表示・ソート・検索・スマート条件・
/// Rules・API で同じ定義を使う。
/// タグの 0 は「未設定」とみなす。
pub fn effective_bpm(t: &Track, a: Option<&TrackAnalysis>) -> Option<f64> {
    t.bpm
        .filter(|&b| b > 0)
        .map(|b| b as f64)
        .or_else(|| a.and_then(|x| x.bpm))
}

/// track_id → 解析結果。並び替えで実効 BPM を引くのに使う。
pub type AnalysisMap = HashMap<i64, TrackAnalysis>;

/// 条件で使えるフィールド (フロントの選択肢と一致させる)。
fn field_value(t: &Track, a: Option<&TrackAnalysis>, field: &str) -> FieldVal {
    match field {
        "trackId" => FieldVal::Num(t.track_id as f64),
        "name" => os(&t.name),
        "artist" => os(&t.artist),
        "albumArtist" => os(&t.album_artist),
        "album" => os(&t.album),
        "genre" => os(&t.genre),
        "grouping" => os(&t.grouping),
        "composer" => os(&t.composer),
        "comments" => os(&t.comments),
        "year" => on(t.year),
        // 実効 BPM = タグ ?? 解析値 (一覧表示・ソート・検索と同じ定義)。
        "bpm" => effective_bpm(t, a)
            .map(FieldVal::Num)
            .unwrap_or(FieldVal::None),
        // rating はスター数 (0-5, 0.5 刻み) で扱う (DB は 0-100)。#172 半星:
        // 70 → 3.5。10 の倍数でない値 (例 65) は最寄りの半星に丸める (UI 表示と同じ)。
        "rating" => t
            .rating
            .map(|r| FieldVal::Num(rating_to_stars(r)))
            .unwrap_or(FieldVal::None),
        "playCount" => on(t.play_count),
        "skipCount" => on(t.skip_count),
        "trackNumber" => on(t.track_number),
        "discNumber" => on(t.disc_number),
        "dateAdded" => os(&t.date_added),
        "dateModified" => os(&t.date_modified),
        "lastPlayed" => os(&t.last_played),
        // 実ファイルのパス (無ければ XML 由来の生 location)。
        "location" => match os(&t.location_path) {
            FieldVal::None => os(&t.location_raw),
            v => v,
        },
        "kind" => os(&t.track_type),
        "compilation" => ob(t.compilation),
        "disabled" => ob(t.disabled),
        // Podcast 判定は保持していないので常に値なし (Rules の旧評価器と同じ)。
        "podcast" => FieldVal::None,
        // 技術メタデータ (#171)。
        "bitrate" => on(t.bitrate_kbps),
        "sampleRate" => on(t.sample_rate_hz),
        "bitDepth" => on(t.bit_depth),
        "channels" => on(t.channels),
        "fileSize" => on(t.file_size_bytes),
        "codec" => os(&t.codec),
        // 実効キー: 手動上書き (tracks.key_camelot_user) ?? 解析値。
        "key" | "keyCamelot" => t
            .key_camelot_user
            .clone()
            .or_else(|| a.and_then(|x| x.key_camelot.clone()))
            .map(FieldVal::Str)
            .unwrap_or(FieldVal::None),
        "energy" => a
            .and_then(|x| x.energy)
            .map(FieldVal::Num)
            .unwrap_or(FieldVal::None),
        _ => FieldVal::None,
    }
}

fn str_op(s: &str, r: &SmartRule, level: FoldLevel) -> bool {
    // Off でも従来の大小無視は保つため to_lowercase を使う。
    // Light 以上は fold が小文字化を含むので、全レベルで大小無視は維持される。
    let normalize = |x: &str| {
        if level == FoldLevel::Off {
            x.to_lowercase()
        } else {
            fold(x, level)
        }
    };
    let a = normalize(s);
    let b = normalize(&r.value);
    match r.op {
        SmartOp::Is => a == b,
        SmartOp::IsNot => a != b,
        SmartOp::Contains => a.contains(&b),
        SmartOp::NotContains => !a.contains(&b),
        SmartOp::StartsWith => a.starts_with(&b),
        SmartOp::EndsWith => a.ends_with(&b),
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
        // 数値に文字列演算子が来たら文字列化して判定。
        SmartOp::Contains => n.to_string().contains(r.value.trim()),
        SmartOp::NotContains => !n.to_string().contains(r.value.trim()),
        SmartOp::StartsWith => n.to_string().starts_with(r.value.trim()),
        SmartOp::EndsWith => n.to_string().ends_with(r.value.trim()),
        SmartOp::Exists | SmartOp::NotExists => true,
    }
}

fn rule_matches(t: &Track, a: Option<&TrackAnalysis>, r: &SmartRule, ctx: &EvalContext) -> bool {
    if r.field == PLAYLIST_FIELD {
        // 参照先が無い (削除済み・未解決) なら空集合扱い: is → false / isNot → true。
        let member = ctx
            .membership
            .get(r.value.trim())
            .is_some_and(|set| set.contains(&t.track_id));
        return match r.op {
            SmartOp::Is => member,
            SmartOp::IsNot => !member,
            _ => false,
        };
    }
    let v = field_value(t, a, &r.field);
    match r.op {
        SmartOp::Exists => !matches!(v, FieldVal::None),
        SmartOp::NotExists => matches!(v, FieldVal::None),
        _ => match v {
            // 値が無い曲: 否定の演算 (isNot / notContains) は「一致しない = 条件を満たす」とみなし、
            // それ以外 (is / contains / 大小比較など) は満たさない。iTunes と同じ扱いで、
            // 例えば「ジャンルに Soundtrack を含まない」はジャンル未設定の曲も含む。
            FieldVal::None => matches!(r.op, SmartOp::IsNot | SmartOp::NotContains),
            FieldVal::Str(s) => str_op(&s, r, ctx.level),
            FieldVal::Num(n) => num_op(n, r),
        },
    }
}

/// 子を持たない (= 実効的に空の) グループか。空グループは評価時に読み飛ばす。
fn group_is_empty(g: &SmartGroup) -> bool {
    g.rules.is_empty() && g.groups.iter().all(group_is_empty)
}

/// 1 ノード (ルール列 + 子グループ) の判定。空の子グループは読み飛ばし、
/// 実効的な子が 1 つも無ければ全件一致 (従来の「ルールなし = 全曲」と同じ)。
fn node_matches(
    t: &Track,
    a: Option<&TrackAnalysis>,
    match_all: bool,
    rules: &[SmartRule],
    groups: &[SmartGroup],
    ctx: &EvalContext,
) -> bool {
    let mut children = rules
        .iter()
        .map(|r| (Some(r), None))
        .chain(
            groups
                .iter()
                .filter(|g| !group_is_empty(g))
                .map(|g| (None, Some(g))),
        )
        .peekable();
    if children.peek().is_none() {
        return true;
    }
    let mut eval = |(r, g): (Option<&SmartRule>, Option<&SmartGroup>)| match (r, g) {
        (Some(r), _) => rule_matches(t, a, r, ctx),
        (None, Some(g)) => node_matches(t, a, g.match_all, &g.rules, &g.groups, ctx),
        (None, None) => true,
    };
    if match_all {
        children.all(&mut eval)
    } else {
        children.any(&mut eval)
    }
}

/// 1 曲が条件に一致するか。ルールもグループも (実効的に) 空なら全件一致。
pub fn track_matches(
    t: &Track,
    a: Option<&TrackAnalysis>,
    c: &SmartCriteria,
    ctx: &EvalContext,
) -> bool {
    node_matches(t, a, c.match_all, &c.rules, &c.groups, ctx)
}

/// 条件ツリー中のプレイリスト参照 (persistent_id) を出現順・重複なしで列挙する。
pub fn referenced_playlists(c: &SmartCriteria) -> Vec<String> {
    fn walk(rules: &[SmartRule], groups: &[SmartGroup], out: &mut Vec<String>) {
        for r in rules {
            let pid = r.value.trim();
            if r.field == PLAYLIST_FIELD && !pid.is_empty() && !out.iter().any(|p| p == pid) {
                out.push(pid.to_string());
            }
        }
        for g in groups {
            walk(&g.rules, &g.groups, out);
        }
    }
    let mut out = Vec::new();
    walk(&c.rules, &c.groups, &mut out);
    out
}

/// 条件ツリー中の全ルールを (入れ子も含めて) 可変で走査する。参照の付け替えに使う。
pub fn for_each_rule_mut(c: &mut SmartCriteria, f: &mut dyn FnMut(&mut SmartRule)) {
    fn walk(rules: &mut [SmartRule], groups: &mut [SmartGroup], f: &mut dyn FnMut(&mut SmartRule)) {
        for r in rules.iter_mut() {
            f(r);
        }
        for g in groups.iter_mut() {
            walk(&mut g.rules, &mut g.groups, f);
        }
    }
    walk(&mut c.rules, &mut c.groups, f);
}

fn lower(v: &Option<String>) -> String {
    v.as_deref().unwrap_or("").to_lowercase()
}

/// location の比較用 (実ファイルのパス優先、無ければ生 location)。
fn location_key(t: &Track) -> String {
    t.location_path
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(t.location_raw.as_deref())
        .unwrap_or("")
        .to_lowercase()
}

/// 2 曲を 1 フィールドだけで比較する (昇順、同値なら Equal。未知のフィールドは name 順)。
/// `an` があれば bpm は実効 BPM (タグ ?? 解析値) で比較する。
fn compare_field(a: &Track, b: &Track, field: &str, an: Option<&AnalysisMap>) -> Ordering {
    match field {
        "trackId" => a.track_id.cmp(&b.track_id),
        "name" => lower(&a.name).cmp(&lower(&b.name)),
        "artist" => lower(&a.artist).cmp(&lower(&b.artist)),
        "album" => lower(&a.album).cmp(&lower(&b.album)),
        "albumArtist" => lower(&a.album_artist).cmp(&lower(&b.album_artist)),
        "genre" => lower(&a.genre).cmp(&lower(&b.genre)),
        "grouping" => lower(&a.grouping).cmp(&lower(&b.grouping)),
        "composer" => lower(&a.composer).cmp(&lower(&b.composer)),
        "comments" => lower(&a.comments).cmp(&lower(&b.comments)),
        "bpm" => {
            let bpm = |t: &Track| effective_bpm(t, an.and_then(|m| m.get(&t.track_id)));
            // Option の順序 (None < Some) は従来の i64 比較と同じ。
            match (bpm(a), bpm(b)) {
                (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
                (x, y) => x.is_some().cmp(&y.is_some()),
            }
        }
        "rating" => a.rating.cmp(&b.rating),
        "playCount" => a.play_count.cmp(&b.play_count),
        "skipCount" => a.skip_count.cmp(&b.skip_count),
        "year" => a.year.cmp(&b.year),
        "totalTimeMs" => a.total_time_ms.cmp(&b.total_time_ms),
        "trackNumber" => a.track_number.cmp(&b.track_number),
        "discNumber" => a.disc_number.cmp(&b.disc_number),
        "dateAdded" => a.date_added.cmp(&b.date_added),
        "dateModified" => a.date_modified.cmp(&b.date_modified),
        "lastPlayed" => a.last_played.cmp(&b.last_played),
        "location" => location_key(a).cmp(&location_key(b)),
        "kind" => lower(&a.track_type).cmp(&lower(&b.track_type)),
        "compilation" => a.compilation.cmp(&b.compilation),
        "disabled" => a.disabled.cmp(&b.disabled),
        // 常に値なし = 全曲同順位。
        "podcast" => Ordering::Equal,
        "bitrate" => a.bitrate_kbps.cmp(&b.bitrate_kbps),
        "sampleRate" => a.sample_rate_hz.cmp(&b.sample_rate_hz),
        "bitDepth" => a.bit_depth.cmp(&b.bit_depth),
        "channels" => a.channels.cmp(&b.channels),
        "fileSize" => a.file_size_bytes.cmp(&b.file_size_bytes),
        "codec" => lower(&a.codec).cmp(&lower(&b.codec)),
        _ => lower(&a.name).cmp(&lower(&b.name)),
    }
}

/// 2 曲を指定フィールドで比較する (昇順。同値は track_id で安定化)。
pub fn compare_tracks(a: &Track, b: &Track, field: &str, an: Option<&AnalysisMap>) -> Ordering {
    compare_field(a, b, field, an).then_with(|| a.track_id.cmp(&b.track_id))
}

/// criteria 自身の並び (`sort_by` + `sort_desc`、同順位なら `then_by` を順に) で比較する。
/// `sort_by` が無ければ name 昇順。最後は track_id で安定化する (第 1 キーが降順なら
/// track_id も降順 = `then_by` が空なら従来の `compare_tracks(..).reverse()` と同じ)。
pub fn compare_by_criteria(
    a: &Track,
    b: &Track,
    c: &SmartCriteria,
    an: Option<&AnalysisMap>,
) -> Ordering {
    let field = c.sort_by.as_deref().unwrap_or("name");
    let dir = |ord: Ordering, desc: bool| if desc { ord.reverse() } else { ord };
    let mut ord = dir(compare_field(a, b, field, an), c.sort_desc);
    for key in &c.then_by {
        if ord != Ordering::Equal {
            break;
        }
        ord = dir(compare_field(a, b, &key.field, an), key.desc);
    }
    ord.then_with(|| dir(a.track_id.cmp(&b.track_id), c.sort_desc))
}

/// マッチ済みトラックを指定フィールドで並び替える (NULL/空は末尾)。
pub fn sort_tracks(tracks: &mut [Track], field: &str, desc: bool, an: Option<&AnalysisMap>) {
    tracks.sort_by(|a, b| {
        let ord = compare_tracks(a, b, field, an);
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
            bitrate_kbps: None,
            sample_rate_hz: None,
            bit_depth: None,
            channels: None,
            file_size_bytes: None,
            codec: None,
            key_camelot_user: None,
            grouping: None,
        }
    }

    /// プレイリスト参照なしで評価する (従来テスト用)。
    fn matches_lvl(
        t: &Track,
        a: Option<&TrackAnalysis>,
        c: &SmartCriteria,
        level: FoldLevel,
    ) -> bool {
        let membership = HashMap::new();
        track_matches(
            t,
            a,
            c,
            &EvalContext {
                level,
                membership: &membership,
            },
        )
    }

    fn rule(field: &str, op: SmartOp, value: &str) -> SmartRule {
        SmartRule {
            field: field.to_string(),
            op,
            value: value.to_string(),
        }
    }

    /// #172 半星: rating 70 は 3.5 星として比較される。65 は最寄りの半星 3.5 に丸める。
    #[test]
    fn rating_half_stars() {
        let crit = |op, v: &str| SmartCriteria {
            match_all: true,
            rules: vec![rule("rating", op, v)],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        let half = track(1, "A", None, Some(70));
        assert!(matches_lvl(
            &half,
            None,
            &crit(SmartOp::Is, "3.5"),
            FoldLevel::Standard
        ));
        assert!(matches_lvl(
            &half,
            None,
            &crit(SmartOp::Gte, "3.5"),
            FoldLevel::Standard
        ));
        assert!(matches_lvl(
            &half,
            None,
            &crit(SmartOp::Gt, "3"),
            FoldLevel::Standard
        ));
        assert!(!matches_lvl(
            &half,
            None,
            &crit(SmartOp::Gte, "4"),
            FoldLevel::Standard
        ));
        assert!(!matches_lvl(
            &half,
            None,
            &crit(SmartOp::Is, "3"),
            FoldLevel::Standard
        ));
        let odd = track(2, "A", None, Some(65));
        assert!(matches_lvl(
            &odd,
            None,
            &crit(SmartOp::Is, "3.5"),
            FoldLevel::Standard
        ));
        let full = track(3, "A", None, Some(60));
        assert!(matches_lvl(
            &full,
            None,
            &crit(SmartOp::Is, "3"),
            FoldLevel::Standard
        ));
        assert!(matches_lvl(
            &full,
            None,
            &crit(SmartOp::Lt, "3.5"),
            FoldLevel::Standard
        ));
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
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        assert!(matches_lvl(&t, None, &all, FoldLevel::Standard));

        let any = SmartCriteria {
            match_all: false,
            rules: vec![
                rule("artist", SmartOp::Is, "nobody"),
                rule("bpm", SmartOp::Lt, "100"),
                rule("genre", SmartOp::Contains, "house"),
            ],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        assert!(matches_lvl(&t, None, &any, FoldLevel::Standard)); // genre matches
    }

    #[test]
    fn numeric_and_exists() {
        let t = track(1, "X", None, None);
        assert!(matches_lvl(
            &t,
            None,
            &SmartCriteria {
                match_all: true,
                rules: vec![rule("bpm", SmartOp::NotExists, "")],
                groups: vec![],
                limit: None,
                sort_by: None,
                sort_desc: false,
                then_by: Vec::new(),
            },
            FoldLevel::Standard
        ));
        let t2 = track(2, "X", Some(128), None);
        assert!(!matches_lvl(
            &t2,
            None,
            &SmartCriteria {
                match_all: true,
                rules: vec![rule("bpm", SmartOp::Lt, "120")],
                groups: vec![],
                limit: None,
                sort_by: None,
                sort_desc: false,
                then_by: Vec::new(),
            },
            FoldLevel::Standard
        ));
    }

    #[test]
    fn han_variant_matches_standard_only() {
        // genre="國楽" の曲。Standard では value="国" の Contains が字体ゆれを越えて一致する。
        let mut t = track(1, "X", Some(120), None);
        t.genre = Some("國楽".to_string());
        let crit = SmartCriteria {
            match_all: true,
            rules: vec![rule("genre", SmartOp::Contains, "国")],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        // Standard: 繁体字 "國" が簡体字 "国" に畳まれて一致。
        assert!(matches_lvl(&t, None, &crit, FoldLevel::Standard));
        // Off / Light: 漢字は畳まれないので一致しない (従来挙動)。
        assert!(!matches_lvl(&t, None, &crit, FoldLevel::Off));
        assert!(!matches_lvl(&t, None, &crit, FoldLevel::Light));
    }

    #[test]
    fn off_keeps_case_insensitive() {
        // Off でも大小無視は維持される (genre="House" に value="HOUSE" が一致)。
        let t = track(1, "X", Some(120), None);
        let crit = SmartCriteria {
            match_all: true,
            rules: vec![rule("genre", SmartOp::Is, "HOUSE")],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        assert!(matches_lvl(&t, None, &crit, FoldLevel::Off));
    }

    #[test]
    fn sort_desc_by_bpm() {
        let mut v = vec![
            track(1, "A", Some(120), None),
            track(2, "B", Some(128), None),
            track(3, "C", Some(124), None),
        ];
        sort_tracks(&mut v, "bpm", true, None);
        assert_eq!(
            v.iter().map(|t| t.track_id).collect::<Vec<_>>(),
            vec![2, 3, 1]
        );
    }

    fn analysis_bpm(id: i64, bpm: f64) -> TrackAnalysis {
        TrackAnalysis {
            track_id: id,
            version: 1,
            analyzed_at: String::new(),
            bpm: Some(bpm),
            key_camelot: None,
            key_name: None,
            key_camelot_user: None,
            energy: None,
            loudness_lufs: None,
            replaygain_db: None,
            vector: Vec::new(),
            peaks: Vec::new(),
        }
    }

    /// 実効 BPM = タグ ?? 解析値。条件評価と並び替えの両方で同じ値を使う。
    #[test]
    fn effective_bpm_prefers_tag_then_analysis() {
        let tagged = track(1, "A", Some(120), None);
        let untagged = track(2, "B", None, None);
        let a1 = analysis_bpm(1, 140.0);
        let a2 = analysis_bpm(2, 130.0);
        assert_eq!(effective_bpm(&tagged, Some(&a1)), Some(120.0));
        assert_eq!(effective_bpm(&untagged, Some(&a2)), Some(130.0));
        assert_eq!(effective_bpm(&untagged, None), None);

        let c = crit(true, vec![rule("bpm", SmartOp::Gte, "125")], vec![]);
        // タグ 120 は解析値 140 があっても対象外、タグ無しは解析値 130 で対象。
        assert!(!matches_lvl(&tagged, Some(&a1), &c, FoldLevel::Standard));
        assert!(matches_lvl(&untagged, Some(&a2), &c, FoldLevel::Standard));
        let exists = crit(true, vec![rule("bpm", SmartOp::Exists, "")], vec![]);
        assert!(matches_lvl(&untagged, Some(&a2), &exists, FoldLevel::Standard));

        let mut an = AnalysisMap::new();
        an.insert(1, a1);
        an.insert(2, a2);
        let mut v = vec![
            tagged.clone(),
            untagged.clone(),
            track(3, "C", None, None),
        ];
        sort_tracks(&mut v, "bpm", false, Some(&an));
        // 未設定 (3) → 120 (1) → 130 (2: 解析値)。
        assert_eq!(
            v.iter().map(|t| t.track_id).collect::<Vec<_>>(),
            vec![3, 1, 2]
        );
    }

    fn crit(match_all: bool, rules: Vec<SmartRule>, groups: Vec<SmartGroup>) -> SmartCriteria {
        SmartCriteria {
            match_all,
            rules,
            groups,
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        }
    }

    fn group(match_all: bool, rules: Vec<SmartRule>, groups: Vec<SmartGroup>) -> SmartGroup {
        SmartGroup {
            match_all,
            rules,
            groups,
        }
    }

    /// 入れ子グループ: ALL[ ANY[genre contains house, genre contains techno], bpm >= 120 ]。
    #[test]
    fn nested_groups() {
        let c = crit(
            true,
            vec![rule("bpm", SmartOp::Gte, "120")],
            vec![group(
                false,
                vec![
                    rule("genre", SmartOp::Contains, "techno"),
                    rule("genre", SmartOp::Contains, "house"),
                ],
                vec![],
            )],
        );
        let fast_house = track(1, "A", Some(124), None);
        assert!(matches_lvl(&fast_house, None, &c, FoldLevel::Standard));
        let slow_house = track(2, "A", Some(100), None);
        assert!(!matches_lvl(&slow_house, None, &c, FoldLevel::Standard));
        let mut fast_idm = track(3, "A", Some(130), None);
        fast_idm.genre = Some("IDM".into());
        assert!(!matches_lvl(&fast_idm, None, &c, FoldLevel::Standard));

        // 3 段の入れ子 (ANY の中の ALL)。
        let deep = crit(
            false,
            vec![rule("artist", SmartOp::Is, "nobody")],
            vec![group(
                true,
                vec![],
                vec![group(
                    true,
                    vec![
                        rule("genre", SmartOp::Is, "idm"),
                        rule("bpm", SmartOp::Gt, "125"),
                    ],
                    vec![],
                )],
            )],
        );
        assert!(matches_lvl(&fast_idm, None, &deep, FoldLevel::Standard));
        assert!(!matches_lvl(&fast_house, None, &deep, FoldLevel::Standard));
    }

    /// 空グループは読み飛ばす。実効的な子が無ければ全件一致。
    #[test]
    fn empty_groups_are_skipped() {
        let t = track(1, "A", Some(120), None);
        // ルールなし + 空グループだけ → 全件一致 (ALL でも ANY でも)。
        for match_all in [true, false] {
            let c = crit(
                match_all,
                vec![],
                vec![group(false, vec![], vec![group(true, vec![], vec![])])],
            );
            assert!(matches_lvl(&t, None, &c, FoldLevel::Standard));
        }
        // ANY[artist is nobody, (空)] は空グループに引きずられて一致しない。
        let c = crit(
            false,
            vec![rule("artist", SmartOp::Is, "nobody")],
            vec![group(true, vec![], vec![])],
        );
        assert!(!matches_lvl(&t, None, &c, FoldLevel::Standard));
    }

    /// プレイリスト参照はコンテキストのメンバー集合で判定し、未知の参照は空集合扱い。
    #[test]
    fn playlist_rule_uses_context_membership() {
        let mut membership = HashMap::new();
        membership.insert("AAAA000000000001".to_string(), HashSet::from([1_i64, 3]));
        let ctx = EvalContext {
            level: FoldLevel::Standard,
            membership: &membership,
        };
        let is = crit(
            true,
            vec![rule(PLAYLIST_FIELD, SmartOp::Is, "AAAA000000000001")],
            vec![],
        );
        let is_not = crit(
            true,
            vec![rule(PLAYLIST_FIELD, SmartOp::IsNot, "AAAA000000000001")],
            vec![],
        );
        let t1 = track(1, "A", None, None);
        let t2 = track(2, "A", None, None);
        assert!(track_matches(&t1, None, &is, &ctx));
        assert!(!track_matches(&t2, None, &is, &ctx));
        assert!(!track_matches(&t1, None, &is_not, &ctx));
        assert!(track_matches(&t2, None, &is_not, &ctx));

        // 存在しない参照先: is は常に偽、isNot は常に真。
        let missing_is = crit(
            true,
            vec![rule(PLAYLIST_FIELD, SmartOp::Is, "FFFF000000000000")],
            vec![],
        );
        let missing_not = crit(
            true,
            vec![rule(PLAYLIST_FIELD, SmartOp::IsNot, "FFFF000000000000")],
            vec![],
        );
        assert!(!track_matches(&t1, None, &missing_is, &ctx));
        assert!(track_matches(&t1, None, &missing_not, &ctx));

        // 参照の列挙は入れ子も含めて重複なし。
        let nested = crit(
            true,
            vec![rule(PLAYLIST_FIELD, SmartOp::Is, "B")],
            vec![group(
                false,
                vec![
                    rule(PLAYLIST_FIELD, SmartOp::Is, "A"),
                    rule(PLAYLIST_FIELD, SmartOp::IsNot, "B"),
                ],
                vec![],
            )],
        );
        assert_eq!(referenced_playlists(&nested), vec!["B", "A"]);
    }

    #[test]
    fn starts_with_and_ends_with() {
        let mut t = track(1, "Daft Punk", None, None);
        t.name = Some("Ｏｎｅ More Time".into());
        let c = |op, v: &str| crit(true, vec![rule("name", op, v)], vec![]);
        // 全角も Contains と同じ正規化 (fold) で畳まれる。
        assert!(matches_lvl(
            &t,
            None,
            &c(SmartOp::StartsWith, "one"),
            FoldLevel::Standard
        ));
        assert!(matches_lvl(
            &t,
            None,
            &c(SmartOp::EndsWith, "TIME"),
            FoldLevel::Standard
        ));
        assert!(!matches_lvl(
            &t,
            None,
            &c(SmartOp::StartsWith, "time"),
            FoldLevel::Standard
        ));
        assert!(!matches_lvl(
            &t,
            None,
            &c(SmartOp::EndsWith, "one"),
            FoldLevel::Standard
        ));
        // Off でも大小無視。
        assert!(matches_lvl(
            &t,
            None,
            &c(SmartOp::EndsWith, "TIME"),
            FoldLevel::Off
        ));
    }

    /// 値が無い曲: isNot / notContains は満たす (iTunes 互換)、それ以外の演算は満たさない。
    #[test]
    fn missing_value_semantics() {
        let mut t = track(1, "X", None, None);
        t.genre = None;
        let m = |field: &str, op, v: &str| {
            matches_lvl(
                &t,
                None,
                &crit(true, vec![rule(field, op, v)], vec![]),
                FoldLevel::Standard,
            )
        };
        // 文字列 (genre 未設定)。
        assert!(m("genre", SmartOp::NotContains, "Soundtrack"));
        assert!(m("genre", SmartOp::IsNot, "House"));
        for op in [
            SmartOp::Is,
            SmartOp::Contains,
            SmartOp::StartsWith,
            SmartOp::EndsWith,
            SmartOp::Gt,
            SmartOp::Lt,
            SmartOp::Gte,
            SmartOp::Lte,
        ] {
            assert!(!m("genre", op, "a"), "{op:?}");
        }
        // 数値 (bpm / rating 未設定)。
        assert!(m("bpm", SmartOp::IsNot, "120"));
        assert!(m("rating", SmartOp::NotContains, "5"));
        for op in [
            SmartOp::Is,
            SmartOp::Gt,
            SmartOp::Lt,
            SmartOp::Gte,
            SmartOp::Lte,
        ] {
            assert!(!m("bpm", op, "120"), "{op:?}");
        }
        // exists / notExists は従来どおり。
        assert!(m("genre", SmartOp::NotExists, ""));
        assert!(!m("genre", SmartOp::Exists, ""));
    }

    #[test]
    fn grouping_field() {
        let mut t = track(1, "A", None, None);
        let c = crit(
            true,
            vec![rule("grouping", SmartOp::Contains, "idol")],
            vec![],
        );
        assert!(!matches_lvl(&t, None, &c, FoldLevel::Standard));
        t.grouping = Some("Idol Unit".into());
        assert!(matches_lvl(&t, None, &c, FoldLevel::Standard));
        let empty = crit(true, vec![rule("grouping", SmartOp::NotExists, "")], vec![]);
        assert!(!matches_lvl(&t, None, &empty, FoldLevel::Standard));
    }

    /// 旧形式 (groups なし) の JSON はそのまま読め、groups は空になる。
    #[test]
    fn legacy_json_deserializes() {
        let json = r#"{"matchAll":true,"rules":[{"field":"genre","op":"contains","value":"house"}],"limit":null,"sortBy":null,"sortDesc":false}"#;
        let c: SmartCriteria = serde_json::from_str(json).unwrap();
        assert!(c.groups.is_empty());
        assert_eq!(c.rules.len(), 1);
        let op: SmartOp = serde_json::from_str("\"startsWith\"").unwrap();
        assert_eq!(op, SmartOp::StartsWith);
    }

    /// Rules から来るフィールド (trackId / discNumber / dateModified / location / kind /
    /// compilation / disabled / podcast) も評価できる。
    #[test]
    fn rules_fields_are_evaluable() {
        let mut t = track(7, "A", None, None);
        t.disc_number = Some(2);
        t.date_modified = Some("2024-05-01T00:00:00Z".into());
        t.location_raw = Some("file:///raw/song.mp3".into());
        t.track_type = Some("MPEG audio file".into());
        t.compilation = true;
        let m = |t: &Track, field: &str, op, v: &str| {
            matches_lvl(
                t,
                None,
                &crit(true, vec![rule(field, op, v)], vec![]),
                FoldLevel::Standard,
            )
        };
        assert!(m(&t, "trackId", SmartOp::Is, "7"));
        assert!(m(&t, "discNumber", SmartOp::Gte, "2"));
        assert!(m(&t, "dateModified", SmartOp::StartsWith, "2024-05"));
        // location_path が無ければ生 location を見る。
        assert!(m(&t, "location", SmartOp::Contains, "/raw/"));
        t.location_path = Some("/music/real.flac".into());
        assert!(m(&t, "location", SmartOp::EndsWith, ".flac"));
        assert!(!m(&t, "location", SmartOp::Contains, "/raw/"));
        assert!(m(&t, "kind", SmartOp::Contains, "mpeg"));
        // bool は 1 / 0。
        assert!(m(&t, "compilation", SmartOp::Is, "1"));
        assert!(m(&t, "disabled", SmartOp::Is, "0"));
        assert!(m(&t, "disabled", SmartOp::Exists, ""));
        // podcast は常に値なし。
        assert!(m(&t, "podcast", SmartOp::NotExists, ""));
        assert!(!m(&t, "podcast", SmartOp::Is, "1"));
        for f in FIELDS {
            assert!(
                SORT_FIELDS.contains(f) || ["key", "keyCamelot", "energy"].contains(f),
                "{f} は並び替えにも使えること"
            );
        }
    }

    /// then_by: 第 1 キーが同順位なら第 2 キー以降で並べる。
    #[test]
    fn compare_by_criteria_uses_then_by() {
        let mut v = [
            track(1, "B", Some(120), Some(80)),
            track(2, "A", Some(120), Some(60)),
            track(3, "A", Some(128), Some(80)),
            track(4, "A", Some(120), Some(80)),
        ];
        let mut c = crit(true, vec![], vec![]);
        c.sort_by = Some("artist".into());
        c.then_by = vec![
            crate::models::SmartSortKey {
                field: "bpm".into(),
                desc: true,
            },
            crate::models::SmartSortKey {
                field: "rating".into(),
                desc: false,
            },
        ];
        v.sort_by(|a, b| compare_by_criteria(a, b, &c, None));
        assert_eq!(
            v.iter().map(|t| t.track_id).collect::<Vec<_>>(),
            vec![3, 2, 4, 1]
        );
        // then_by が空なら従来どおり (第 1 キー降順は track_id も降順)。
        c.then_by.clear();
        c.sort_desc = true;
        v.sort_by(|a, b| compare_by_criteria(a, b, &c, None));
        assert_eq!(
            v.iter().map(|t| t.track_id).collect::<Vec<_>>(),
            vec![1, 4, 3, 2]
        );
    }
}
