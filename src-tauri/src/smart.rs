//! スマートプレイリストの条件評価と並び替え。
//!
//! Track のフィールドに加えて解析結果 (Camelot key / energy) も条件に使える。
//! メンバーシップは保存せず、開くたびにライブ評価する。
//!
//! 「プレイリストに含まれる」条件 (`field = "playlist"`) は、参照先のメンバー集合を
//! 呼び出し側 (DB 層) が事前に解決して [`EvalContext`] に渡す。ここは純粋関数のまま保つ。

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::{
    DateTime, Duration, Local, LocalResult, Months, NaiveDate, NaiveDateTime, TimeZone, Utc,
};

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
    /// 相対日付 (`inLast` / `notInLast`) の基準時刻。評価パス (DB 層の `PlaylistResolver` 1 つ) ごとに
    /// 一度だけ現在時刻を取り、そのパスの全評価で使う (結果を日をまたいで使い回さない。テストでは固定値)。
    /// か月の計算はこの時刻をローカル時刻に直して行う。
    pub now: DateTime<Utc>,
}

/// 相対日付 (`inLast` / `notInLast`) の単位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelativeUnit {
    Day,
    Week,
    /// 暦の月 (ローカル時刻の暦で数える。3 月 31 日の 1 か月前は 2 月末日)。
    Month,
}

/// 相対日付で数えられる期間の上限 (日 / 週 / か月。約 100 年)。超える値は読めない値として扱う。
/// フロントの `src/lib/relativeDate.ts` と一致させる。
pub const RELATIVE_MAX_DAYS: u32 = 36_500;
pub const RELATIVE_MAX_WEEKS: u32 = 5_200;
pub const RELATIVE_MAX_MONTHS: u32 = 1_200;

/// 相対日付の条件が使える (日付の) フィールド。
pub const RELATIVE_DATE_FIELDS: &[&str] = &["dateAdded", "dateModified", "lastPlayed"];

impl RelativeUnit {
    /// この単位で数えられる期間の上限。
    pub fn max_count(self) -> u32 {
        match self {
            RelativeUnit::Day => RELATIVE_MAX_DAYS,
            RelativeUnit::Week => RELATIVE_MAX_WEEKS,
            RelativeUnit::Month => RELATIVE_MAX_MONTHS,
        }
    }

    fn suffix(self) -> char {
        match self {
            RelativeUnit::Day => 'd',
            RelativeUnit::Week => 'w',
            RelativeUnit::Month => 'm',
        }
    }
}

/// 相対日付の値 (`"30d"` / `"2w"` / `"3m"`) を読む。正の整数 + 単位 (d / w / m、大小無視)。
/// 読めない値 (0・負数・単位なし・小数・上限 [`RelativeUnit::max_count`] 超など) は None。
pub fn parse_relative_date(value: &str) -> Option<(u32, RelativeUnit)> {
    let v = value.trim();
    let unit = match v.chars().last()?.to_ascii_lowercase() {
        'd' => RelativeUnit::Day,
        'w' => RelativeUnit::Week,
        'm' => RelativeUnit::Month,
        _ => return None,
    };
    let num = &v[..v.len() - 1];
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = num.parse().ok()?;
    (n > 0 && n <= unit.max_count()).then_some((n, unit))
}

/// [`parse_relative_date`] の逆 (`(30, Day)` → `"30d"`)。
pub fn format_relative_date(n: u32, unit: RelativeUnit) -> String {
    format!("{n}{}", unit.suffix())
}

/// 「過去 N 単位以内」の境界 (この時刻以降なら以内)。日・週は 24 時間 × N を引き、月は `now` の
/// タイムゾーン (評価ではローカル時刻) の暦の月で引く (月末は丸める)。表せない (桁あふれ) 値だけ None。
fn relative_threshold<Tz: TimeZone>(
    now: DateTime<Tz>,
    n: u32,
    unit: RelativeUnit,
) -> Option<DateTime<Utc>> {
    let utc_now = now.with_timezone(&Utc);
    match unit {
        RelativeUnit::Day => utc_now.checked_sub_signed(Duration::try_days(n as i64)?),
        RelativeUnit::Week => utc_now.checked_sub_signed(Duration::try_weeks(n as i64)?),
        RelativeUnit::Month => {
            // DateTime<Tz>::checked_sub_months は夏時間の重複・欠落で None になるので、
            // 壁時計 (naive) で引いてから自前で解決する。
            let naive = now.naive_local().checked_sub_months(Months::new(n))?;
            let tz = now.timezone();
            resolve_local(naive, |t| tz.from_local_datetime(t))
                .or_else(|| utc_now.checked_sub_months(Months::new(n)))
        }
    }
}

/// 夏時間の切り替えで欠落した時刻を探すときに、1 時間ずつ進める最大回数
/// (欠落は通常 1 時間。日付変更線をまたいだ 1 日の欠落まで覆う)。
const GAP_SEARCH_HOURS: u32 = 25;

/// 壁時計の時刻をタイムゾーンで解決する。1 つに決まればそれ、重複 (夏時間の終わり) なら早いほう、
/// 欠落 (夏時間の始まり) なら 1 時間ずつ後ろへずらして最初に存在する時刻。見つからなければ None
/// (呼び出し側が UTC の暦で引き直す)。`resolve` はテストで任意の結果を返せるよう関数で受ける。
fn resolve_local<Tz: TimeZone>(
    naive: NaiveDateTime,
    resolve: impl Fn(&NaiveDateTime) -> LocalResult<DateTime<Tz>>,
) -> Option<DateTime<Utc>> {
    let mut t = naive;
    for _ in 0..=GAP_SEARCH_HOURS {
        match resolve(&t) {
            LocalResult::Single(d) => return Some(d.with_timezone(&Utc)),
            LocalResult::Ambiguous(earliest, _) => return Some(earliest.with_timezone(&Utc)),
            LocalResult::None => t = t.checked_add_signed(Duration::hours(1))?,
        }
    }
    None
}

/// 日付フィールドの文字列を時刻として読む。DB の主な形式は `2017-01-01T23:59:59Z` (UTC)。
/// オフセット付きの RFC 3339、オフセットなしの日時 (UTC とみなす)、日付だけ (UTC の 0 時) も受ける。
fn parse_field_date(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(d.and_utc());
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc())
}

/// `inLast` / `notInLast` の判定。値が読めなければ (どちらの演算でも) 一致しない。
/// 日付が無い・日付として読めない曲は「値なし」: inLast は満たさず、notInLast は満たす
/// (isNot / notContains と同じ扱い)。境界ちょうど (now − N) は「以内」に入る。
/// 日付フィールド ([`RELATIVE_DATE_FIELDS`]) 以外に付いた条件は、どちらの演算でも一致しない。
fn relative_date_op(v: FieldVal, r: &SmartRule, now: DateTime<Utc>) -> bool {
    if !RELATIVE_DATE_FIELDS.contains(&r.field.as_str()) {
        return false;
    }
    let Some(threshold) = parse_relative_date(&r.value)
        .and_then(|(n, unit)| relative_threshold(now.with_timezone(&Local), n, unit))
    else {
        return false;
    };
    let date = match v {
        FieldVal::Str(s) => parse_field_date(&s),
        _ => None,
    };
    match date {
        Some(d) => (d >= threshold) == (r.op == SmartOp::InLast),
        None => r.op == SmartOp::NotInLast,
    }
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
        // rating は星 (0-5) で扱う (DB は 0-100。70 → 3.5)。is / 大小比較は `rule_matches` が
        // 検索構文 `rating:` と同じ区間方式で判定する (`rating_op`)。ここの値 (rating ÷ 20) は
        // contains などの文字列演算だけが使う。
        "rating" => t
            .rating
            .map(|r| FieldVal::Num(crate::rating::rating_to_stars_exact(r as f64)))
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
        // 相対日付は rule_matches が先に判定する (ここには来ない)。
        SmartOp::InLast | SmartOp::NotInLast => false,
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
        SmartOp::InLast | SmartOp::NotInLast => false,
    }
}

/// rating の is / isNot / 大小比較。星の条件の意味は検索構文 `rating:` と同じ区間方式
/// ([`crate::rating::rating_matches_stars`]): `is 3` は rating 60〜79、`is 0` は 0〜19、
/// 比較は星を連続値とみなす。それ以外の演算子は `None` (呼び出し側が数値の一般則で判定)。
fn rating_op(rating: i64, r: &SmartRule) -> Option<bool> {
    use crate::rating::{rating_matches_stars, StarCmp};
    let (cmp, negate) = match r.op {
        SmartOp::Is => (StarCmp::Eq, false),
        SmartOp::IsNot => (StarCmp::Eq, true),
        SmartOp::Gt => (StarCmp::Gt, false),
        SmartOp::Gte => (StarCmp::Gte, false),
        SmartOp::Lt => (StarCmp::Lt, false),
        SmartOp::Lte => (StarCmp::Lte, false),
        _ => return None,
    };
    let Ok(stars) = r.value.trim().parse::<f64>() else {
        // 数値として読めない値は、ほかの数値フィールドと同じくどの曲にも一致しない。
        return Some(false);
    };
    Some(rating_matches_stars(rating, cmp, stars) != negate)
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
    if matches!(r.op, SmartOp::InLast | SmartOp::NotInLast) {
        return relative_date_op(field_value(t, a, &r.field), r, ctx.now);
    }
    if r.field == "rating" {
        if let Some(matched) = t.rating.and_then(|rating| rating_op(rating, r)) {
            return matched;
        }
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
        // 曲名・アーティスト・アルバムは一覧の ORDER BY (COLLATE NATSORT) と同じ自然順 (D10)。
        "name" => natural(&a.name, &b.name),
        "artist" => natural(&a.artist, &b.artist),
        "album" => natural(&a.album, &b.album),
        "albumArtist" => natural(&a.album_artist, &b.album_artist),
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
        _ => natural(&a.name, &b.name),
    }
}

fn natural(a: &Option<String>, b: &Option<String>) -> Ordering {
    crate::natural_sort::natural_cmp(a.as_deref().unwrap_or(""), b.as_deref().unwrap_or(""))
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

/// 文字列フィールドの値なし (None・空文字・空白のみ) か。文字列でないフィールドは false。
/// 一覧の ORDER BY (`db::tracks::build_order_by` の `NULLIF(TRIM(x), '') IS NULL`) と同じ判定。
fn text_missing(t: &Track, field: &str) -> bool {
    let v = match field {
        "name" => &t.name,
        "artist" => &t.artist,
        "album" => &t.album,
        "albumArtist" => &t.album_artist,
        "genre" => &t.genre,
        "grouping" => &t.grouping,
        "composer" => &t.composer,
        "comments" => &t.comments,
        "kind" => &t.track_type,
        "codec" => &t.codec,
        "dateAdded" => &t.date_added,
        "dateModified" => &t.date_modified,
        "lastPlayed" => &t.last_played,
        _ => return false,
    };
    v.as_deref().is_none_or(|s| s.trim().is_empty())
}

/// マッチ済みトラックを指定フィールドで並び替える (UI のソート指定。一覧の ORDER BY と揃える)。
/// 文字列フィールドの値なしは方向によらず末尾。
pub fn sort_tracks(tracks: &mut [Track], field: &str, desc: bool, an: Option<&AnalysisMap>) {
    tracks.sort_by(|a, b| {
        let missing = text_missing(a, field).cmp(&text_missing(b, field));
        missing.then_with(|| {
            let ord = compare_tracks(a, b, field, an);
            if desc {
                ord.reverse()
            } else {
                ord
            }
        })
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
                now: Utc::now(),
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

    /// rating の条件は検索構文 `rating:` と同じ区間方式 (R1)。
    /// 整数星は半星を含む (is 3 = 60〜79)、半星は自分だけ (is 3.5 = 70〜79)、比較は連続値。
    #[test]
    fn rating_uses_search_syntax_intervals() {
        let crit = |op, v: &str| SmartCriteria {
            match_all: true,
            rules: vec![rule("rating", op, v)],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        };
        let m = |rating: Option<i64>, op, v: &str| {
            matches_lvl(&track(1, "A", None, rating), None, &crit(op, v), FoldLevel::Standard)
        };
        // 3.5 星 (70)。
        assert!(m(Some(70), SmartOp::Is, "3.5"));
        assert!(m(Some(70), SmartOp::Gte, "3.5"));
        assert!(m(Some(70), SmartOp::Gt, "3"));
        assert!(!m(Some(70), SmartOp::Gte, "4"));
        // 仕様変更: 整数星の is は半星も含む (検索の rating:3 と同じ 60〜79)。
        assert!(m(Some(70), SmartOp::Is, "3"));
        assert!(!m(Some(70), SmartOp::IsNot, "3"));
        assert!(m(Some(60), SmartOp::Is, "3"));
        assert!(!m(Some(60), SmartOp::Is, "3.5"));
        assert!(m(Some(60), SmartOp::Lt, "3.5"));
        assert!(!m(Some(80), SmartOp::Is, "3"));
        // is 0 = 0〜19。
        assert!(m(Some(0), SmartOp::Is, "0"));
        assert!(m(Some(10), SmartOp::Is, "0"));
        assert!(!m(Some(20), SmartOp::Is, "0"));
        // 仕様変更: 10 の倍数でない rating は最寄りの半星に丸めない。65 は 3 星の区間。
        assert!(m(Some(65), SmartOp::Is, "3"));
        assert!(!m(Some(65), SmartOp::Is, "3.5"));
        assert!(!m(Some(65), SmartOp::Gte, "3.5"));
        // 格子に無い境界値 (iTunes の「> 49」= 2.45 星) は rating ÷ 20 と比べる。
        assert!(!m(Some(45), SmartOp::Gt, "2.45"));
        assert!(m(Some(50), SmartOp::Gt, "2.45"));
        // rating が無い曲の扱いは変えていない: 否定の演算だけが一致する。
        assert!(!m(None, SmartOp::Is, "0"));
        assert!(!m(None, SmartOp::Lt, "3"));
        assert!(m(None, SmartOp::IsNot, "3"));
        // 数値として読めない値はどの曲にも一致しない。
        assert!(!m(Some(60), SmartOp::Is, "three"));
        // 文字列演算は rating ÷ 20 の文字列に対して行う。
        assert!(m(Some(70), SmartOp::Contains, "3.5"));
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

    /// UI のソート指定: 文字列フィールドの値なし (None・空・空白のみ) は昇順・降順とも末尾
    /// (一覧の ORDER BY と同じ。コンピレーションの空アルバムアーティストが先頭に来ないこと)。
    #[test]
    fn sort_tracks_puts_empty_text_last_both_directions() {
        let with_aa = |id: i64, aa: Option<&str>| {
            let mut t = track(id, "A", None, None);
            t.album_artist = aa.map(str::to_string);
            t
        };
        let make = || {
            vec![
                with_aa(1, None),
                with_aa(2, Some("")),
                with_aa(3, Some("  ")),
                with_aa(4, Some("Beta")),
                with_aa(5, Some("alpha")),
            ]
        };
        let ids = |v: &[Track]| v.iter().map(|t| t.track_id).collect::<Vec<_>>();
        let mut v = make();
        sort_tracks(&mut v, "albumArtist", false, None);
        assert_eq!(ids(&v), vec![5, 4, 1, 2, 3]);
        let mut v = make();
        sort_tracks(&mut v, "albumArtist", true, None);
        assert_eq!(ids(&v), vec![4, 5, 3, 2, 1]);
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
            now: Utc::now(),
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

    /// タグの無い曲 (artist / albumArtist / album が NULL または空文字): 値が無い扱いで、
    /// isNot / notContains は満たし、is / contains などは満たさない (取り込みでフォルダ名を
    /// 埋めなくなったので、空の曲がこの規則で Rules / スマートに入る)。
    #[test]
    fn untagged_artist_album_are_missing_values() {
        for empty in [None, Some(String::new())] {
            let mut t = track(1, "", None, None);
            t.artist = empty.clone();
            t.album_artist = empty.clone();
            t.album = empty.clone();
            let m = |field: &str, op, v: &str| {
                matches_lvl(
                    &t,
                    None,
                    &crit(true, vec![rule(field, op, v)], vec![]),
                    FoldLevel::Standard,
                )
            };
            for field in ["artist", "albumArtist", "album"] {
                assert!(m(field, SmartOp::IsNot, "Daft Punk"), "{field} {empty:?}");
                assert!(m(field, SmartOp::NotContains, "daft"), "{field} {empty:?}");
                assert!(!m(field, SmartOp::Is, "Daft Punk"), "{field} {empty:?}");
                assert!(!m(field, SmartOp::Contains, "daft"), "{field} {empty:?}");
                assert!(!m(field, SmartOp::StartsWith, "d"), "{field} {empty:?}");
                assert!(m(field, SmartOp::NotExists, ""), "{field} {empty:?}");
                assert!(!m(field, SmartOp::Exists, ""), "{field} {empty:?}");
            }
        }
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

    /// 固定した現在時刻で 1 ルールを評価する。
    fn matches_at(t: &Track, r: SmartRule, now: &str) -> bool {
        let membership = HashMap::new();
        track_matches(
            t,
            None,
            &crit(true, vec![r], vec![]),
            &EvalContext {
                level: FoldLevel::Standard,
                membership: &membership,
                now: DateTime::parse_from_rfc3339(now).unwrap().with_timezone(&Utc),
            },
        )
    }

    #[test]
    fn parse_relative_date_values() {
        assert_eq!(parse_relative_date("30d"), Some((30, RelativeUnit::Day)));
        assert_eq!(parse_relative_date(" 2W "), Some((2, RelativeUnit::Week)));
        assert_eq!(parse_relative_date("3m"), Some((3, RelativeUnit::Month)));
        for bad in ["", "d", "0d", "-1d", "1.5d", "30", "30y", "3 m", "abc", "99999999999d"] {
            assert_eq!(parse_relative_date(bad), None, "{bad}");
        }
        // 上限 (36500 日 / 5200 週 / 1200 か月) まで読み、超えたら読めない値。
        assert_eq!(parse_relative_date("36500d"), Some((36_500, RelativeUnit::Day)));
        assert_eq!(parse_relative_date("5200w"), Some((5_200, RelativeUnit::Week)));
        assert_eq!(parse_relative_date("1200m"), Some((1_200, RelativeUnit::Month)));
        for bad in ["36501d", "5201w", "1201m"] {
            assert_eq!(parse_relative_date(bad), None, "{bad}");
        }
        assert_eq!(format_relative_date(30, RelativeUnit::Day), "30d");
        assert_eq!(format_relative_date(3, RelativeUnit::Month), "3m");
    }

    /// 過去 N 日 / 週: 現在時刻から 24 時間 × N を引いた時刻以降 (境界ちょうどを含む)。
    #[test]
    fn in_last_days_and_weeks() {
        let now = "2026-03-31T12:00:00Z";
        let mut t = track(1, "X", None, None);
        let at = |t: &mut Track, d: &str| t.date_added = Some(d.to_string());

        at(&mut t, "2026-03-01T12:00:00Z"); // ちょうど 30 日前
        assert!(matches_at(&t, rule("dateAdded", SmartOp::InLast, "30d"), now));
        assert!(!matches_at(&t, rule("dateAdded", SmartOp::NotInLast, "30d"), now));
        at(&mut t, "2026-03-01T11:59:59Z"); // 30 日と 1 秒前
        assert!(!matches_at(&t, rule("dateAdded", SmartOp::InLast, "30d"), now));
        assert!(matches_at(&t, rule("dateAdded", SmartOp::NotInLast, "30d"), now));

        at(&mut t, "2026-03-17T12:00:00Z"); // ちょうど 2 週間前
        assert!(matches_at(&t, rule("dateAdded", SmartOp::InLast, "2w"), now));
        assert!(!matches_at(&t, rule("dateAdded", SmartOp::InLast, "1w"), now));
        assert!(matches_at(&t, rule("dateAdded", SmartOp::NotInLast, "1w"), now));

        // 未来の日付も「以内」に入る (境界より後)。
        at(&mut t, "2026-04-10T00:00:00Z");
        assert!(matches_at(&t, rule("dateAdded", SmartOp::InLast, "1d"), now));
    }

    /// か月の境界は `now` のタイムゾーンの暦で引く (3/31 の 1 か月前は 2/28、月末は丸める)。
    #[test]
    fn month_threshold_uses_local_calendar() {
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap();
        let utc = |s: &str| at(s).with_timezone(&Utc);
        // UTC の暦: 3/31 12:00Z → 2/28 12:00Z。
        assert_eq!(
            relative_threshold(utc("2026-03-31T12:00:00Z"), 1, RelativeUnit::Month),
            Some(utc("2026-02-28T12:00:00Z"))
        );
        // 同じ瞬間でも JST (+09:00) では 3/31 21:00 → 2/28 21:00 JST。
        assert_eq!(
            relative_threshold(at("2026-03-31T21:00:00+09:00"), 1, RelativeUnit::Month),
            Some(utc("2026-02-28T12:00:00Z"))
        );
        // UTC では 3/30 だが JST では 3/31 の瞬間: JST の暦で 3/31 → 2/28 (UTC の暦なら 2/28 20:00Z)。
        assert_eq!(
            relative_threshold(at("2026-03-31T05:00:00+09:00"), 1, RelativeUnit::Month),
            Some(utc("2026-02-27T20:00:00Z"))
        );
        assert_eq!(
            relative_threshold(utc("2026-03-30T20:00:00Z"), 1, RelativeUnit::Month),
            Some(utc("2026-02-28T20:00:00Z"))
        );
        // 3 か月 (年をまたぐ)。
        assert_eq!(
            relative_threshold(at("2026-03-31T12:00:00-05:00"), 3, RelativeUnit::Month),
            Some(utc("2025-12-31T17:00:00Z"))
        );
        // 日・週はタイムゾーンによらず 24 時間 × N。
        assert_eq!(
            relative_threshold(at("2026-03-31T05:00:00+09:00"), 2, RelativeUnit::Week),
            Some(utc("2026-03-16T20:00:00Z"))
        );
    }

    /// 夏時間の重複・欠落でも境界が決まる (ローカル時刻の解決結果を差し替えて確かめる)。
    #[test]
    fn resolve_local_handles_dst() {
        use chrono::FixedOffset;
        let naive = |s: &str| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").unwrap();
        let utc = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        let est = FixedOffset::west_opt(5 * 3600).unwrap();
        let edt = FixedOffset::west_opt(4 * 3600).unwrap();

        // 1 つに決まる。
        let single = resolve_local(naive("2026-03-01T01:30:00"), |t| {
            LocalResult::Single(est.from_local_datetime(t).unwrap())
        });
        assert_eq!(single, Some(utc("2026-03-01T06:30:00Z")));

        // 重複 (11/1 01:30 は EDT と EST の 2 回): 早いほう (EDT = 05:30Z)。
        let ambiguous = resolve_local(naive("2026-11-01T01:30:00"), |t| {
            LocalResult::Ambiguous(
                edt.from_local_datetime(t).unwrap(),
                est.from_local_datetime(t).unwrap(),
            )
        });
        assert_eq!(ambiguous, Some(utc("2026-11-01T05:30:00Z")));

        // 欠落 (3/8 02:00〜03:00 が無い): 1 時間後ろの 03:30 EDT。
        let gap = resolve_local(naive("2026-03-08T02:30:00"), |t| {
            if t.format("%H").to_string() == "02" {
                LocalResult::None
            } else {
                LocalResult::Single(edt.from_local_datetime(t).unwrap())
            }
        });
        assert_eq!(gap, Some(utc("2026-03-08T07:30:00Z")));

        // どこまでずらしても見つからなければ None (relative_threshold は UTC の暦で引き直す)。
        let never = resolve_local::<FixedOffset>(naive("2026-03-08T02:30:00"), |_| LocalResult::None);
        assert_eq!(never, None);
    }

    /// 夏時間のあるローカル時刻でも、か月の境界が None にならない (TZ=America/New_York などで意味を持つ。
    /// どのタイムゾーンでも Some で、前後 1 か月 ± 1 日に収まる)。
    #[test]
    fn month_threshold_is_some_around_dst() {
        for now in ["2026-12-01T06:30:00Z", "2026-04-08T06:30:00Z", "2026-03-31T12:00:00Z"] {
            let now = DateTime::parse_from_rfc3339(now).unwrap().with_timezone(&Utc);
            let th = relative_threshold(now.with_timezone(&Local), 1, RelativeUnit::Month)
                .unwrap_or_else(|| panic!("None for {now}"));
            let days = (now - th).num_hours() as f64 / 24.0;
            assert!((27.0..=32.0).contains(&days), "{now}: {th} ({days} days)");
        }
    }

    /// 過去 N か月の評価 (境界はローカル時刻の暦なので、境界から十分離れた日付で確かめる)。
    #[test]
    fn in_last_months_uses_calendar_months() {
        let now = "2026-03-31T12:00:00Z";
        let mut t = track(1, "X", None, None);
        t.last_played = Some("2026-03-02T12:00:00Z".into());
        assert!(matches_at(&t, rule("lastPlayed", SmartOp::InLast, "1m"), now));
        t.last_played = Some("2026-02-25T12:00:00Z".into());
        assert!(!matches_at(&t, rule("lastPlayed", SmartOp::InLast, "1m"), now));
        // 3 か月前 ≒ 2025-12-31。
        t.last_played = Some("2026-01-03T00:00:00Z".into());
        assert!(matches_at(&t, rule("lastPlayed", SmartOp::InLast, "3m"), now));
        t.last_played = Some("2025-12-28T00:00:00Z".into());
        assert!(!matches_at(&t, rule("lastPlayed", SmartOp::InLast, "3m"), now));
        assert!(matches_at(&t, rule("lastPlayed", SmartOp::NotInLast, "3m"), now));
        // dateModified も同じ。
        t.date_modified = Some("2026-01-15T00:00:00Z".into());
        assert!(matches_at(&t, rule("dateModified", SmartOp::InLast, "3m"), now));
    }

    /// 基準時刻は評価ごとの now (同じ曲でも、評価する日が変われば結果が変わる)。
    #[test]
    fn in_last_is_relative_to_eval_time() {
        let mut t = track(1, "X", None, None);
        t.date_added = Some("2026-03-01T00:00:00Z".into());
        let r = || rule("dateAdded", SmartOp::InLast, "7d");
        assert!(matches_at(&t, r(), "2026-03-05T00:00:00Z"));
        assert!(!matches_at(&t, r(), "2026-03-09T00:00:00Z"));
    }

    /// 日付が無い・読めない曲は値なし (inLast は満たさず notInLast は満たす)。
    /// 値 (30d など) が読めなければ、どちらの演算もどの曲にも一致しない。
    #[test]
    fn in_last_missing_and_invalid_values() {
        let now = "2026-03-31T12:00:00Z";
        let mut t = track(1, "X", None, None);
        assert!(!matches_at(&t, rule("lastPlayed", SmartOp::InLast, "30d"), now));
        assert!(matches_at(&t, rule("lastPlayed", SmartOp::NotInLast, "30d"), now));
        t.last_played = Some("not a date".into());
        assert!(!matches_at(&t, rule("lastPlayed", SmartOp::InLast, "30d"), now));
        assert!(matches_at(&t, rule("lastPlayed", SmartOp::NotInLast, "30d"), now));

        // 別の書式 (オフセット付き・日付だけ) も読める。
        t.last_played = Some("2026-03-30T09:00:00+09:00".into());
        assert!(matches_at(&t, rule("lastPlayed", SmartOp::InLast, "2d"), now));
        t.last_played = Some("2026-03-30".into());
        assert!(matches_at(&t, rule("lastPlayed", SmartOp::InLast, "2d"), now));

        for bad in ["", "30", "0d", "x"] {
            t.last_played = Some("2026-03-30T00:00:00Z".into());
            assert!(!matches_at(&t, rule("lastPlayed", SmartOp::InLast, bad), now), "{bad}");
            assert!(!matches_at(&t, rule("lastPlayed", SmartOp::NotInLast, bad), now), "{bad}");
            t.last_played = None;
            assert!(!matches_at(&t, rule("lastPlayed", SmartOp::NotInLast, bad), now), "{bad}");
        }
    }

    /// 日付以外のフィールドに付いた相対日付の条件は、どちらの演算でも一致しない。
    #[test]
    fn in_last_on_non_date_field_matches_nothing() {
        let now = "2026-03-31T12:00:00Z";
        let mut t = track(1, "X", Some(120), None);
        t.comments = Some("2026-03-30T00:00:00Z".into());
        for field in ["comments", "genre", "bpm", "playCount", "unknownField", "playlist"] {
            assert!(!matches_at(&t, rule(field, SmartOp::InLast, "30d"), now), "{field}");
            assert!(!matches_at(&t, rule(field, SmartOp::NotInLast, "30d"), now), "{field}");
        }
    }

    #[test]
    fn in_last_ops_serialize_camel_case() {
        let r = rule("dateAdded", SmartOp::InLast, "30d");
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"op\":\"inLast\""), "{json}");
        let back: SmartRule =
            serde_json::from_str(r#"{"field":"dateAdded","op":"notInLast","value":"3m"}"#).unwrap();
        assert_eq!(back.op, SmartOp::NotInLast);
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
