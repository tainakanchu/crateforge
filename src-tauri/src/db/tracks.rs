use std::{collections::HashSet, path::Path};

use chrono::DateTime;
use rusqlite::{params, OptionalExtension, Result};
use serde::Serialize;

use super::Database;
use crate::itunes_xml::parser::RawTrack;
use crate::models::{AlbumRow, GenreTagCount, Track, TrackEdit};

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

/// `/api/artists` で返す、ライブラリ内の distinct なアーティスト 1 件分の情報。
/// `artist` は表示アーティスト名 (フォールバック適用済み)。
/// `sample_track_id` はアートワーク表示用の代表トラック (グループ内最小 track_id)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistInfo {
    pub artist: String,
    pub track_count: i64,
    pub sample_track_id: i64,
}

/// 検索対象のテキスト列 (name/artist/album/album_artist/genre/comments)。
/// `search_text` の計算 (Rust 側 compute_search_text) と SQL 側 SEARCH_TEXT_EXPR で
/// 同じ列・同じ順序を使い、両者が必ず一致するようにする。
const SEARCH_COLS: [&str; 6] = [
    "name",
    "artist",
    "album",
    "album_artist",
    "genre",
    "comments",
];

/// `search_text` を **SQL 側で** 計算する式。各列を `fold(col, 2)` (Standard) で畳み、
/// NULL は空文字に倒して改行で連結する。マイグレーションのバックフィルや、
/// 既存行を直接 UPDATE するパス (`recompute_search_text`) で単一の真実の源として使う。
/// Rust 側 `compute_search_text` と必ず同じ結果になること (列・順序・区切り・fold レベル)。
/// NULL 列は `fold(NULL,2)` が NULL を返し、SQLite では `NULL||x` が全体 NULL に伝播するため、
/// 必ず `COALESCE(...,'')` で空文字に倒してから連結する (Rust 側の None→"" と一致させる)。
pub(crate) const SEARCH_TEXT_EXPR: &str = "COALESCE(fold(name,2),'')||char(10)||\
     COALESCE(fold(artist,2),'')||char(10)||COALESCE(fold(album,2),'')||char(10)||\
     COALESCE(fold(album_artist,2),'')||char(10)||COALESCE(fold(genre,2),'')||char(10)||\
     COALESCE(fold(comments,2),'')";

/// アルバム束ねキーの算出式。get_albums の GROUP BY と get_album_tracks の WHERE で同一に使う。
/// - album が空/NULL → `tr:<track_id>` (1曲1グループ。(unknown)へ吸い込ませない)
/// - compilation=1  → `cmp:<album>` のみ (アーティストが曲ごとに違っても1枚に束ねる)
/// - それ以外       → `al:<albumArtist||artist>␟<album>` (char(31)=ユニットセパレータ区切り)
const ALBUM_KEY_EXPR: &str = "CASE \
  WHEN album IS NULL OR trim(album) = '' THEN 'tr:' || track_id \
  WHEN compilation = 1 THEN 'cmp:' || lower(trim(album)) \
  ELSE 'al:' || lower(trim(coalesce(nullif(trim(album_artist),''), artist, ''))) || char(31) || lower(trim(album)) \
END";

/// `search_text` を **Rust 側で** 計算する。insert 経路で、まだ DB に行が無い段階の
/// 値から `search_text` を組み立てるのに使う。SQL 側 `SEARCH_TEXT_EXPR` と等価:
/// 各フィールドを Standard で fold し、NULL/None は空文字、改行 (`\n`) で連結する。
/// (SQL の `fold(NULL,2)` は NULL を返し `COALESCE` 相当に空へ倒れる ── ここでも None→"" と揃える。)
fn compute_search_text(fields: [Option<&str>; 6]) -> String {
    use crate::text_fold::{fold, FoldLevel};
    fields
        .iter()
        .map(|f| fold(f.unwrap_or(""), FoldLevel::Standard))
        .collect::<Vec<_>>()
        .join("\n")
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

/// アルバム粒度の ORDER BY 句を組み立てる。
/// SQL インジェクション防止のため sort_field/sort_order は match で固定文字列に変換する。
/// 全分岐の末尾に `album_key ASC` を足して並びを一意にする (build_order_by の track_id 相当)。
/// これが無いと同値のアルバムの相対順が未定義になり、LIMIT/OFFSET のページ間で
/// 重複・取りこぼしが起きる。`album_key` は get_albums の GROUP BY キーなので必ず一意。
fn album_order_by(sort_field: Option<&str>, sort_order: Option<&str>) -> String {
    let dir = if matches!(sort_order, Some("desc")) {
        "DESC"
    } else {
        "ASC"
    };
    let head = match sort_field {
        Some("albumArtist") => {
            format!("album_artist COLLATE NOCASE {dir}, album COLLATE NOCASE ASC")
        }
        Some("album") => format!("album COLLATE NOCASE {dir}, album_artist COLLATE NOCASE ASC"),
        Some("year") => format!(
            "(year IS NULL), year {dir}, album_artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC"
        ),
        Some("dateAdded") => format!(
            "(date_added IS NULL), date_added {dir}, album_artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC"
        ),
        Some("rating") => format!(
            "(rating IS NULL), rating {dir}, album_artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC"
        ),
        Some("playCount") => {
            format!("play_count {dir}, album_artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC")
        }
        _ => "album_artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC".to_string(),
    };
    format!("{head}, album_key ASC")
}

/// フィールド検索で使える「テキスト列」の別名 → 実カラム名。
/// ここに無いキーは通常のフリーテキストとして扱う。列名はこの表の右辺 (固定文字列) しか
/// SQL に埋めないため、インジェクションの余地は無い。
const TEXT_FIELDS: [(&str, &str); 6] = [
    ("artist", "artist"),
    ("album", "album"),
    ("albumartist", "album_artist"),
    ("album_artist", "album_artist"),
    ("genre", "genre"),
    ("comment", "comments"),
];

/// `search_text` 相当の式を、任意のテーブル別名付きで組み立てる。
/// `prefix` は "" (別名なし) か "t." のような別名 + ドット。
/// prefix が空のときは定数 `SEARCH_TEXT_EXPR` と完全に一致する (テストで保証)。
fn search_text_expr(prefix: &str) -> String {
    SEARCH_COLS
        .iter()
        .map(|c| format!("COALESCE(fold({prefix}{c},2),'')"))
        .collect::<Vec<_>>()
        .join("||char(10)||")
}

/// 検索クエリをトークンに分解する。空白区切りだが、二重引用符で囲まれた範囲は
/// 空白を含めて 1 トークンにまとめる (`artist:"daft punk"` → `artist:daft punk`)。
/// 引用符自体はトークンに残さない。閉じ引用符が無い場合は行末までを 1 トークンとみなす。
fn tokenize_query(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for ch in query.chars() {
        match ch {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// テキスト列 1 本に対する部分一致句。フリーテキスト検索と同じ fold レベルで畳むので、
/// `artist:サクラ` と `artist:さくら` が同じ結果になる (Standard 時)。
/// `col` は `TEXT_FIELDS` の右辺 (固定文字列) のみ。値は必ずバインドする。
fn text_like_clause(
    prefix: &str,
    col: &str,
    value: &str,
    level: crate::text_fold::FoldLevel,
) -> (String, rusqlite::types::Value) {
    use rusqlite::types::Value;
    match level {
        crate::text_fold::FoldLevel::Off => (
            format!("({prefix}{col} LIKE ?)"),
            Value::Text(format!("%{value}%")),
        ),
        _ => {
            let n = level.as_i64();
            (
                format!("(fold({prefix}{col}, {n}) LIKE ?)"),
                Value::Text(format!("%{}%", crate::text_fold::fold(value, level))),
            )
        }
    }
}

/// "2015-2020" → (2015,2020)、"2018" → (2018,2018)。整数の単一値/範囲。
fn parse_int_range(s: &str) -> Option<(i64, i64)> {
    let s = s.trim();
    if let Some((a, b)) = s.split_once('-') {
        let lo: i64 = a.trim().parse().ok()?;
        let hi: i64 = b.trim().parse().ok()?;
        Some((lo.min(hi), lo.max(hi)))
    } else {
        let v: i64 = s.parse().ok()?;
        Some((v, v))
    }
}

/// 星 (0..=5) を rating 列 (0..=100) の範囲に写す。
/// 星 n は「n 〜 n.5 星」= `n*20 ..= n*20+19` に対応させ、5 は 100 で頭打ちにする。
/// rating が NULL の曲は 0 星扱い (COALESCE) なので `rating:0` で未評価を拾える。
fn parse_star_range(s: &str) -> Option<(i64, i64)> {
    let (lo, hi) = parse_int_range(s)?;
    if !(0..=5).contains(&lo) || !(0..=5).contains(&hi) {
        return None;
    }
    Some((lo * 20, (hi * 20 + 19).min(100)))
}

/// `yes`/`no` 系の真偽値を解釈する。
fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "yes" | "y" | "true" | "1" | "on" => Some(true),
        "no" | "n" | "false" | "0" | "off" => Some(false),
        _ => None,
    }
}

/// Camelot キー `base` (例 "8A") とハーモニックに互換なキーを、Camelot ホイール
/// 24 キーから列挙する。判定は analyzer::similarity::camelot_compatible をそのまま
/// 使う (同番号 = 同キー/平行調、隣接番号 ±1 で同種、環状)。
/// `base` が Camelot として解釈できなければ None。
fn compatible_camelot_keys(base: &str) -> Option<Vec<String>> {
    use crate::analyzer::similarity::{camelot_compatible, parse_camelot};
    let base = base.trim().to_uppercase();
    parse_camelot(&base)?;
    let keys: Vec<String> = (1..=12u8)
        .flat_map(|n| ["A", "B"].map(move |m| format!("{n}{m}")))
        .filter(|k| camelot_compatible(&base, k))
        .collect();
    if keys.is_empty() {
        None
    } else {
        Some(keys)
    }
}

/// 検索トークンがフィールド指定 (`bpm:` `key:` `energy:` `artist:` `album:` `albumartist:`
/// `genre:` `year:` `rating:` `comment:` `analyzed:`) なら (SQL 句, バインド値) を返す。\n/// `key:` は `key:compat:8A` の形でハーモニック互換キー一括指定もできる。
/// 解釈できないキー/値なら None を返し、呼び出し側でフリーテキストとして扱う。
/// `prefix` は tracks テーブルの別名 + ドット ("tracks." / "t.")。
/// SQL に埋め込むのは固定文字列だけで、ユーザー入力は必ずバインドする。
fn parse_field_filter(
    tok: &str,
    level: crate::text_fold::FoldLevel,
    prefix: &str,
) -> Option<(String, Vec<rusqlite::types::Value>)> {
    use rusqlite::types::Value;
    let (kind, val) = tok.split_once(':')?;
    let kind = kind.to_ascii_lowercase();
    if let Some((_, col)) = TEXT_FIELDS.iter().find(|(k, _)| *k == kind) {
        let v = val.trim();
        if v.is_empty() {
            return None;
        }
        let (clause, bind) = text_like_clause(prefix, col, v, level);
        return Some((clause, vec![bind]));
    }
    match kind.as_str() {
        "bpm" => {
            let (lo, hi) = parse_range(val, 2.0)?;
            Some((
                format!(
                    "(COALESCE((SELECT bpm FROM track_analysis WHERE track_id = {prefix}track_id), \
                     {prefix}bpm) BETWEEN ? AND ?)"
                ),
                vec![Value::Real(lo), Value::Real(hi)],
            ))
        }
        "key" => {
            let k = val.trim().to_uppercase();
            if k.is_empty() {
                return None;
            }
            // `key:compat:8A` — 8A とハーモニックに繋がるキー全部 (同キー / 平行調 /
            // ホイール ±1) を IN (...) で並べる。
            if let Some(base) = k.strip_prefix("COMPAT:") {
                let keys = compatible_camelot_keys(base)?;
                let holes = vec!["?"; keys.len()].join(",");
                return Some((
                    format!(
                        "{prefix}track_id IN (SELECT track_id FROM track_analysis \
                         WHERE UPPER(key_camelot) IN ({holes}))"
                    ),
                    keys.into_iter().map(Value::Text).collect(),
                ));
            }
            Some((
                format!(
                    "{prefix}track_id IN (SELECT track_id FROM track_analysis WHERE UPPER(key_camelot) = ?)"
                ),
                vec![Value::Text(k)],
            ))
        }
        "energy" => {
            let (lo, hi) = parse_energy_range(val)?;
            Some((
                format!(
                    "{prefix}track_id IN (SELECT track_id FROM track_analysis WHERE energy BETWEEN ? AND ?)"
                ),
                vec![Value::Real(lo), Value::Real(hi)],
            ))
        }
        "year" => {
            let (lo, hi) = parse_int_range(val)?;
            Some((
                format!("({prefix}year BETWEEN ? AND ?)"),
                vec![Value::Integer(lo), Value::Integer(hi)],
            ))
        }
        "rating" => {
            let (lo, hi) = parse_star_range(val)?;
            Some((
                format!("(COALESCE({prefix}rating, 0) BETWEEN ? AND ?)"),
                vec![Value::Integer(lo), Value::Integer(hi)],
            ))
        }
        "analyzed" => {
            let yes = parse_bool(val)?;
            let op = if yes { "EXISTS" } else { "NOT EXISTS" };
            Some((
                format!(
                    "{op} (SELECT 1 FROM track_analysis a WHERE a.track_id = {prefix}track_id)"
                ),
                Vec::new(),
            ))
        }
        _ => None,
    }
}

/// 検索クエリを WHERE 句の断片 (AND 結合前) とバインド値に変換する。
/// フィールド指定トークンはそれぞれの絞り込みに、それ以外はフリーテキストの
/// 部分一致になる。ライブラリ検索とプレイリスト内検索で同じ構文を共有するため、
/// テーブル別名 `prefix` を引数で受ける。
pub(super) fn build_search_clauses(
    query: &str,
    level: crate::text_fold::FoldLevel,
    prefix: &str,
) -> (Vec<String>, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value;
    let mut clauses: Vec<String> = Vec::new();
    let mut bind: Vec<Value> = Vec::new();
    for tok in tokenize_query(query) {
        if let Some((clause, mut binds)) = parse_field_filter(&tok, level, prefix) {
            clauses.push(clause);
            bind.append(&mut binds);
            continue;
        }
        match level {
            // 高速パス (既定): 事前計算済みの `search_text` (Standard で fold 済みの
            // 6 列連結) 1 列だけを LIKE で見る。クエリ時の fold() UDF 呼び出しと
            // 6 列 OR が消え、数万曲でも 1 列スキャンで済む。トークンも Standard で畳む。
            // search_text が NULL の行 (バックフィル前 / 直 SQL 挿入など) のみ、安全網として
            // その場で search_text 相当の式を評価する。通常は COALESCE が短絡し fold は走らない。
            crate::text_fold::FoldLevel::Standard => {
                let pat = format!(
                    "%{}%",
                    crate::text_fold::fold(&tok, crate::text_fold::FoldLevel::Standard)
                );
                bind.push(Value::Text(pat));
                clauses.push(format!(
                    "(COALESCE({prefix}search_text, {expr}) LIKE ?)",
                    expr = search_text_expr(prefix)
                ));
            }
            // Off: 従来どおり `col LIKE ?` に生トークンの `%..%` をバインド。
            crate::text_fold::FoldLevel::Off => {
                let pat = format!("%{}%", tok);
                let group = SEARCH_COLS
                    .iter()
                    .map(|c| {
                        bind.push(Value::Text(pat.clone()));
                        format!("{prefix}{c} LIKE ?")
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ");
                clauses.push(format!("({})", group));
            }
            // Light: search_text は Standard 固定なので使えない。列側を `fold(col, 1)` で
            // 畳み、パターンも Rust 側で Light に畳んでからバインドする従来パス。
            crate::text_fold::FoldLevel::Light => {
                let pat = format!("%{}%", crate::text_fold::fold(&tok, level));
                let n = level.as_i64();
                let group = SEARCH_COLS
                    .iter()
                    .map(|c| {
                        bind.push(Value::Text(pat.clone()));
                        format!("fold({prefix}{c}, {n}) LIKE ?")
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ");
                clauses.push(format!("({})", group));
            }
        }
    }
    (clauses, bind)
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

/// ORDER BY 句を組み立てる。NULL は常に最後、最終的に track_id でタイブレーク。
/// `prefix` は JOIN 時のテーブル別名 ("t." など)。`default` は sort_field が無効な時に丸ごと使う句。
///
/// アルバムをまたぐ系のソート (artist / albumArtist / album) では、同一アルバム内を
/// disc番号 → トラック番号 → 曲名 の自然順 (= ディスクの収録順) で並べる。これが無いと
/// 同一アルバム内が曲名順になってしまう (#sort tie-break)。曲順は主キーの昇降に依らず常に昇順。
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

    // 主キー (NULL は最後)。
    let mut order = format!("({prefix}{col} IS NULL), {prefix}{col}{collate} {dir}");

    // アルバム文脈のソートだけ、収録順のタイブレークを足す (主キーと同じ列はスキップ)。
    if matches!(
        sort_field,
        Some("artist") | Some("albumArtist") | Some("album")
    ) {
        for tb in ["album", "disc_number", "track_number", "name"] {
            if tb == col {
                continue;
            }
            let tb_collate = if tb == "album" || tb == "name" {
                " COLLATE NOCASE"
            } else {
                ""
            };
            order.push_str(&format!(
                ", ({prefix}{tb} IS NULL), {prefix}{tb}{tb_collate} ASC"
            ));
        }
    }

    // 最終タイブレーク (安定化)。
    order.push_str(&format!(", {prefix}track_id ASC"));
    order
}

impl Database {
    /// XML マージ全体を包むトランザクションを開始する。
    pub fn begin_import(&self) -> Result<()> {
        self.conn.execute_batch("BEGIN TRANSACTION;")?;
        Ok(())
    }

    pub fn finish_import(&self) -> Result<()> {
        // XML の整数 ID が衝突して再採番された場合に、永続 ID から派生キャッシュを張り直す。
        // 未接続の解析行も残し、後のインポートで同じ曲が来れば接続できるようにする。
        self.conn.execute_batch(
            "UPDATE track_analysis
             SET track_id = (
                 SELECT tracks.track_id
                 FROM tracks
                 WHERE tracks.persistent_id = track_analysis.persistent_id
             );
             COMMIT;",
        )?;
        Ok(())
    }

    /// XML トラックを persistent_id 優先・location 補助でマージし、実際の DB track_id を返す。
    pub fn insert_track(
        &self,
        raw: &RawTrack,
        location_path: &str,
        file_exists: bool,
        imported_persistent_ids: &mut HashSet<String>,
        claimed_track_ids: &mut HashSet<i64>,
    ) -> Result<i64> {
        let xml_track_id = raw.get_int("Track ID").unwrap_or(0);
        let supplied_persistent_id = raw.get_str("Persistent ID").filter(|id| !id.is_empty());
        let mut matched = if let Some(persistent_id) = supplied_persistent_id {
            if imported_persistent_ids.insert(persistent_id.to_string()) {
                let candidate = self
                    .conn
                    .query_row(
                        "SELECT track_id, date_modified, location_path
                         FROM tracks WHERE persistent_id = ?1",
                        [persistent_id],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, Option<String>>(1)?,
                                row.get::<_, Option<String>>(2)?,
                            ))
                        },
                    )
                    .optional()?;
                candidate.filter(|(track_id, _, _)| !claimed_track_ids.contains(track_id))
            } else {
                None
            }
        } else {
            None
        };

        // PID が欠損・重複・未一致なら、同一取り込み内で未使用の location を補助キーにする。
        if matched.is_none() {
            let location_raw = raw.get_str("Location").unwrap_or("");
            let mut stmt = self.conn.prepare(
                "SELECT track_id, date_modified, location_path
                 FROM tracks
                 WHERE (?1 <> '' AND location_raw = ?1)
                    OR (?2 <> '' AND location_path = ?2)
                 ORDER BY track_id",
            )?;
            let mut rows = stmt.query(params![location_raw, location_path])?;
            while let Some(row) = rows.next()? {
                let track_id = row.get::<_, i64>(0)?;
                if !claimed_track_ids.contains(&track_id) {
                    matched = Some((
                        track_id,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ));
                    break;
                }
            }
        }

        // 検索高速パス用の正規化済みテキスト (compute_search_text が単一の真実の源)。
        let search_text = compute_search_text([
            raw.get_str("Name"),
            raw.get_str("Artist"),
            raw.get_str("Album"),
            raw.get_str("Album Artist"),
            raw.get_str("Genre"),
            raw.get_str("Comments"),
        ]);

        if let Some((track_id, local_modified, local_path)) = matched {
            claimed_track_ids.insert(track_id);
            let xml_modified = raw
                .get_date("Date Modified")
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok());
            let local_modified = local_modified
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok());

            // XML の更新日時が厳密に新しい時だけ、XML 管轄のメタデータを更新する。
            // rating 等のアプリ管轄フィールドはこの UPDATE に含めない。
            let xml_is_newer = match (xml_modified.as_ref(), local_modified.as_ref()) {
                (Some(xml), Some(local)) => xml > local,
                (Some(_), None) => true,
                _ => false,
            };
            if xml_is_newer {
                self.conn.execute(
                    "UPDATE tracks SET
                         name = ?1, artist = ?2, album_artist = ?3, composer = ?4,
                         album = ?5, genre = ?6, year = ?7, bpm = ?8, comments = ?9,
                         total_time_ms = ?10, track_number = ?11, track_count = ?12,
                         disc_number = ?13, disc_count = ?14, compilation = ?15,
                         track_type = ?16, date_added = ?17, date_modified = ?18,
                         search_text = ?19
                     WHERE track_id = ?20",
                    params![
                        raw.get_str("Name"),
                        raw.get_str("Artist"),
                        raw.get_str("Album Artist"),
                        raw.get_str("Composer"),
                        raw.get_str("Album"),
                        raw.get_str("Genre"),
                        raw.get_int("Year"),
                        raw.get_int("BPM"),
                        raw.get_str("Comments"),
                        raw.get_int("Total Time"),
                        raw.get_int("Track Number"),
                        raw.get_int("Track Count"),
                        raw.get_int("Disc Number"),
                        raw.get_int("Disc Count"),
                        raw.get_bool("Compilation") as i32,
                        raw.get_str("Track Type"),
                        raw.get_date("Date Added"),
                        raw.get_date("Date Modified"),
                        search_text,
                        track_id,
                    ],
                )?;
            }

            // 整理済みのローカルファイルが現在も存在する場合だけ、アプリ側の場所を正とする。
            let local_file_exists = local_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .is_some_and(|path| Path::new(path).exists());
            if local_file_exists {
                self.conn.execute(
                    "UPDATE tracks SET file_exists = 1 WHERE track_id = ?1",
                    [track_id],
                )?;
            } else {
                self.conn.execute(
                    "UPDATE tracks
                     SET location_raw = ?1, location_path = ?2, file_exists = ?3
                     WHERE track_id = ?4",
                    params![
                        raw.get_str("Location"),
                        location_path,
                        file_exists as i32,
                        track_id,
                    ],
                )?;
            }

            return Ok(track_id);
        }

        let mut attempt = 0;
        loop {
            let track_id: i64 = if self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tracks WHERE track_id = ?1)",
                [xml_track_id],
                |row| row.get(0),
            )? {
                self.conn.query_row(
                    "SELECT COALESCE(MAX(track_id), 0) + 1 FROM tracks",
                    [],
                    |row| row.get(0),
                )?
            } else {
                xml_track_id
            };
            let persistent_id = super::persistent_id_for_insert(
                &self.conn,
                "tracks",
                supplied_persistent_id,
                track_id as u64,
            )?;
            match self.conn.execute(
                "INSERT INTO tracks (track_id, persistent_id, name, artist, album_artist, composer,
                 album, genre, year, rating, play_count, skip_count, total_time_ms,
                 date_added, date_modified, bpm, comments, location_raw, location_path,
                 track_type, disabled, compilation, disc_number, disc_count,
                 track_number, track_count, file_exists, last_played, search_text)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)",
                params![
                    track_id,
                    persistent_id,
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
                    raw.get_date("Play Date UTC"),
                    search_text,
                ],
            ) {
                Ok(_) => {
                    claimed_track_ids.insert(track_id);
                    return Ok(track_id);
                }
                Err(err) if super::should_retry_constraint(&err, attempt) => {
                    attempt += 1;
                }
                Err(err) => return Err(err),
            }
        }
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
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

        // 検索高速パス用の正規化済みテキスト (comments は取り込み時に無いので None)。
        let search_text = compute_search_text([name, artist, album, album_artist, genre, None]);

        let mut attempt = 0;
        loop {
            let next_id: i64 = self.conn.query_row(
                "SELECT COALESCE(MAX(track_id), 0) + 1 FROM tracks",
                [],
                |r| r.get(0),
            )?;
            let persistent_id =
                super::generate_unique_persistent_id(&self.conn, "tracks", next_id as u64)?;
            match self.conn.execute(
                "INSERT INTO tracks (track_id, persistent_id, name, artist, album_artist, album, genre,
                                     year, track_number, track_count, disc_number, disc_count,
                                     total_time_ms, date_added, location_raw, location_path,
                                     track_type, file_exists, search_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'File', 1, ?17)",
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
                    search_text,
                ],
            ) {
                Ok(_) => return Ok(next_id),
                Err(err) if super::should_retry_constraint(&err, attempt) => {
                    attempt += 1;
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// federation upload 用。クライアントが持つ persistent ID を変更せずに新規曲を追加する。
    /// 呼び出し側は PID の形式検証と既存行の冪等判定を済ませてから呼ぶ。
    #[allow(clippy::too_many_arguments)]
    pub fn add_imported_track_with_persistent_id(
        &self,
        persistent_id: &str,
        name: Option<&str>,
        artist: Option<&str>,
        album_artist: Option<&str>,
        composer: Option<&str>,
        album: Option<&str>,
        genre: Option<&str>,
        year: Option<i64>,
        bpm: Option<i64>,
        comments: Option<&str>,
        track_number: Option<i64>,
        track_count: Option<i64>,
        disc_number: Option<i64>,
        disc_count: Option<i64>,
        compilation: bool,
        rating: Option<i64>,
        total_time_ms: Option<i64>,
        location_path: &str,
        location_url: &str,
    ) -> Result<i64> {
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let search_text = compute_search_text([name, artist, album, album_artist, genre, comments]);

        let mut attempt = 0;
        loop {
            let next_id: i64 = self.conn.query_row(
                "SELECT COALESCE(MAX(track_id), 0) + 1 FROM tracks",
                [],
                |row| row.get(0),
            )?;
            match self.conn.execute(
                "INSERT INTO tracks
                    (track_id, persistent_id, name, artist, album_artist, composer, album, genre,
                     year, rating, total_time_ms, date_added, bpm, comments, location_raw,
                     location_path, track_type, compilation, track_number, track_count,
                     disc_number, disc_count, file_exists, search_text)
                 VALUES
                    (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                     ?15, ?16, 'File', ?17, ?18, ?19, ?20, ?21, 1, ?22)",
                params![
                    next_id,
                    persistent_id,
                    name,
                    artist,
                    album_artist,
                    composer,
                    album,
                    genre,
                    year,
                    rating,
                    total_time_ms,
                    now,
                    bpm,
                    comments,
                    location_url,
                    location_path,
                    compilation as i32,
                    track_number,
                    track_count,
                    disc_number,
                    disc_count,
                    search_text,
                ],
            ) {
                Ok(_) => return Ok(next_id),
                Err(err) if super::should_retry_constraint(&err, attempt) => {
                    // track_id の同時採番衝突だけ再試行する。PID 衝突は上書きしない。
                    let pid_exists: bool = self.conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM tracks WHERE persistent_id = ?1)",
                        [persistent_id],
                        |row| row.get(0),
                    )?;
                    if pid_exists {
                        return Err(err);
                    }
                    attempt += 1;
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// 既存行の `search_text` を、現在の name/artist/album/album_artist/genre/comments から
    /// 再計算する。SQL 側 `SEARCH_TEXT_EXPR` (= Rust 側 compute_search_text と等価) を使い、
    /// どの列が変わっても確実に正しい値へ更新できる。検索対象列を変える全 UPDATE 経路から呼ぶ。
    fn recompute_search_text(&self, track_id: i64) -> Result<()> {
        self.conn.execute(
            &format!(
                "UPDATE tracks SET search_text = {expr} WHERE track_id = ?1",
                expr = SEARCH_TEXT_EXPR,
            ),
            params![track_id],
        )?;
        Ok(())
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
    /// フィールド指定 (`artist:` `album:` `albumartist:` `genre:` `year:` `rating:`
    /// `comment:` `analyzed:` `bpm:` `key:` `energy:`) はその条件に、それ以外は
    /// name/artist/album/album_artist/genre/comments のいずれかへの部分一致 (OR) になり、
    /// トークン同士は AND。値は `artist:"daft punk"` のように引用符で囲める。
    pub fn search_tracks(
        &self,
        query: &str,
        limit: i64,
        offset: i64,
        sort_field: Option<&str>,
        sort_order: Option<&str>,
    ) -> Result<Vec<Track>> {
        use rusqlite::types::Value;

        let order_by = build_order_by(sort_field, sort_order, "", "name COLLATE NOCASE ASC");

        // 検索の字体ゆれ吸収レベル。Off のときは従来と完全に同じ SQL/バインドになる。
        let level = crate::text_fold::FoldLevel::from_state(
            self.get_state("search_fold_level")
                .ok()
                .flatten()
                .as_deref(),
        );

        // 各トークンを AND 結合。句とバインド値の組み立ては build_search_clauses に集約し、
        // プレイリスト内検索と同じ構文を共有する (ここは FROM tracks なので prefix は "tracks.")。
        let (clauses, mut bind): (Vec<String>, Vec<Value>) =
            build_search_clauses(query, level, "tracks.");
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

    /// 指定した persistent_id 群を、入力順を保って Track へ解決する。
    /// 見つからない ID はスキップする。テーブルは小さいため prepared statement を再利用する。
    pub fn get_tracks_by_persistent_ids(&self, persistent_ids: &[String]) -> Result<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists, last_played
             FROM tracks WHERE persistent_id = ?1",
        )?;
        let mut out = Vec::with_capacity(persistent_ids.len());
        for persistent_id in persistent_ids {
            if let Some(track) = stmt
                .query_row(params![persistent_id], row_to_track)
                .optional()?
            {
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

        // 検索対象列 (name/artist/album/album_artist/genre/comments) のいずれかが変われば
        // 更新後に search_text を再計算する (composer は検索対象外なので無視)。
        let touches_search = edits.name.is_some()
            || edits.artist.is_some()
            || edits.album.is_some()
            || edits.album_artist.is_some()
            || edits.genre.is_some()
            || edits.comments.is_some();
        set_int_clear!(year, "year");
        set_int_clear!(bpm, "bpm");
        set_int_opt!(rating, "rating");
        set_int_clear!(track_number, "track_number");
        set_int_clear!(track_count, "track_count");
        set_int_clear!(disc_number, "disc_number");
        set_int_clear!(disc_count, "disc_count");
        // play_count / skip_count は DB のみ (Some(None) で NULL クリア)。
        set_int_clear!(play_count, "play_count");
        set_int_clear!(skip_count, "skip_count");

        if let Some(v) = edits.compilation {
            sets.push("compilation = ?");
            values.push(rusqlite::types::Value::Integer(if v { 1 } else { 0 }));
        }
        if let Some(v) = edits.disabled {
            sets.push("disabled = ?");
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
        if touches_search {
            self.recompute_search_text(track_id)?;
        }
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

    /// rating は XML インポートの更新対象外なので、時計を進めなくても値は保護される。
    /// 進めると逆に XML 側の正当な更新まで止まるため据え置く。結果として
    /// 同期の書き戻しでは rating 衝突の新旧を判定できず、既定は手元の値になる。
    pub fn set_rating(&self, track_id: i64, rating: i64) -> Result<()> {
        // date_modified は XML メタデータの LWW 時計なので、保護フィールドの rating では進めない。
        self.conn.execute(
            "UPDATE tracks SET rating = ?1 WHERE track_id = ?2",
            params![rating, track_id],
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
        // genre は検索対象列なので search_text を再計算する。
        self.recompute_search_text(track_id)?;
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
        // genre は検索対象列なので search_text を再計算する。
        self.recompute_search_text(track_id)?;
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
    pub fn get_albums_legacy(&self) -> Result<Vec<AlbumInfo>> {
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

    /// アルバムグリッド向けの集約クエリ。コンピレーション対応・カバー代表曲選択済み。
    pub fn get_albums(
        &self,
        sort_field: Option<&str>,
        sort_order: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<AlbumRow>> {
        let order_by = album_order_by(sort_field, sort_order);
        let sql = format!(
            "WITH base AS (
              SELECT *,
                ({key}) AS album_key,
                ROW_NUMBER() OVER (
                  PARTITION BY ({key})
                  ORDER BY file_exists DESC, (disc_number IS NULL), disc_number,
                           (track_number IS NULL), track_number, track_id
                ) AS rn
              FROM tracks
            )
            SELECT
              album_key,
              MAX(coalesce(nullif(trim(album),''), name, '(unknown)'))          AS album,
              MAX(CASE WHEN compilation=1 THEN 'Various Artists'
                       ELSE coalesce(nullif(trim(album_artist),''), artist, '') END) AS album_artist,
              MAX(compilation)                                                   AS is_compilation,
              COUNT(*)                                                           AS track_count,
              MAX(CASE WHEN rn=1 THEN track_id END)                              AS cover_track_id,
              MAX(CASE WHEN rn=1 THEN location_path END)                         AS cover_location_path,
              MAX(CASE WHEN rn=1 THEN file_exists END)                           AS cover_file_exists,
              COALESCE(SUM(total_time_ms),0)                                     AS total_time_ms,
              MIN(year)                                                          AS year,
              MAX(date_added)                                                    AS date_added,
              MAX(rating)                                                        AS rating,
              COALESCE(SUM(play_count),0)                                        AS play_count,
              MIN(bpm)                                                           AS bpm_min,
              MAX(bpm)                                                           AS bpm_max
            FROM base
            GROUP BY album_key
            ORDER BY {order}
            LIMIT ?1 OFFSET ?2",
            key = ALBUM_KEY_EXPR,
            order = order_by
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit, offset], |r| {
            Ok(AlbumRow {
                album_key: r.get(0)?,
                album: r.get(1)?,
                album_artist: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                is_compilation: r.get::<_, i32>(3)? != 0,
                track_count: r.get(4)?,
                cover_track_id: r.get(5)?,
                cover_location_path: r.get(6)?,
                cover_file_exists: r.get::<_, Option<i32>>(7)?.unwrap_or(0) != 0,
                total_time_ms: r.get(8)?,
                year: r.get(9)?,
                date_added: r.get(10)?,
                rating: r.get(11)?,
                play_count: r.get(12)?,
                bpm_min: r.get(13)?,
                bpm_max: r.get(14)?,
            })
        })?;
        rows.collect()
    }

    /// album_key に属するトラック一覧をディスク→トラック順で返す。
    /// 同一の ALBUM_KEY_EXPR で WHERE するため get_albums と完全に一致する。
    pub fn get_album_tracks(&self, album_key: &str) -> Result<Vec<Track>> {
        let sql = format!(
            "SELECT id, track_id, persistent_id, name, artist, album_artist, composer,
                    album, genre, year, rating, play_count, skip_count, total_time_ms,
                    date_added, date_modified, bpm, comments, location_raw, location_path,
                    track_type, disabled, compilation, disc_number, disc_count,
                    track_number, track_count, file_exists, last_played
             FROM (
               SELECT *, ({key}) AS album_key FROM tracks
             ) WHERE album_key = ?1
             ORDER BY (disc_number IS NULL), disc_number,
                      (track_number IS NULL), track_number, track_id",
            key = ALBUM_KEY_EXPR
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![album_key], row_to_track)?;
        rows.collect()
    }

    /// ライブラリ内の distinct な表示アーティスト一覧を表示名 (NOCASE) 昇順で返す。
    /// `by_album_artist=false` (grouping=artist): artist→album_artist→"Unknown Artist"。
    /// `by_album_artist=true`  (grouping=albumArtist): album_artist→artist→"Unknown Artist"。
    /// 表示名でグループ化し、`track_count` は COUNT(*)、`sample_track_id` は MIN(track_id)。
    /// 共有インターフェース契約 (TS の trackArtist/trackAlbumArtist) と完全一致させる:
    /// 空文字 "" は falsy=次へ、NULL も次へ、空白のみ " " は truthy=採用。
    pub fn get_artists(&self, by_album_artist: bool) -> Result<Vec<ArtistInfo>> {
        // 表示名式: 優先列が NULL でも空文字 '' でもない → 採用、それ以外は次の列、
        // どちらも無効なら 'Unknown Artist'。grouping により artist/album_artist の優先を入替。
        let (first, second) = if by_album_artist {
            ("album_artist", "artist")
        } else {
            ("artist", "album_artist")
        };
        let display_expr = format!(
            "CASE WHEN {first} IS NOT NULL AND {first} != '' THEN {first} \
                  WHEN {second} IS NOT NULL AND {second} != '' THEN {second} \
                  ELSE 'Unknown Artist' END"
        );
        let sql = format!(
            "SELECT {display_expr} AS display_name, COUNT(*), MIN(track_id) FROM tracks \
             GROUP BY display_name ORDER BY display_name COLLATE NOCASE"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(ArtistInfo {
                artist: r.get(0)?,
                track_count: r.get(1)?,
                sample_track_id: r.get(2)?,
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
    use std::collections::HashSet;

    use super::{album_order_by, common_dir_prefix, compute_search_text};
    use crate::db::Database;

    /// album_order_by は全分岐で `album_key ASC` を最終タイブレークに持つこと
    /// (LIMIT/OFFSET のページ間で並びが揺れないため)。
    #[test]
    fn album_order_by_always_ends_with_album_key_tiebreak() {
        for field in [
            None,
            Some("albumArtist"),
            Some("album"),
            Some("year"),
            Some("dateAdded"),
            Some("rating"),
            Some("playCount"),
            Some("bogus"),
        ] {
            for order in [None, Some("asc"), Some("desc")] {
                let sql = album_order_by(field, order);
                assert!(
                    sql.ends_with(", album_key ASC"),
                    "missing tie-break for {field:?}/{order:?}: {sql}"
                );
            }
        }
        assert_eq!(
            album_order_by(Some("year"), Some("desc")),
            "(year IS NULL), year DESC, album_artist COLLATE NOCASE ASC, \
             album COLLATE NOCASE ASC, album_key ASC"
        );
    }

    /// Standard 高速パス: 検索が `search_text` 1 列を見て、字体ゆれ (ひらがな⇔カタカナ・
    /// 全角英字・繁体字) を吸収して従来と同じ結果を返すこと。insert_track 経路で
    /// search_text が必ず埋まることも同時に保証する。
    #[test]
    fn search_fast_path_folds_variants() {
        use crate::itunes_xml::parser::{PlistValue, RawTrack};
        let db = Database::open_memory().unwrap();
        // 既定 (search_fold_level 未設定) は Standard なので高速パスが効く。
        let mut imported_persistent_ids = HashSet::new();
        let mut imported_track_ids = HashSet::new();
        let mut mk = |tid: i64, name: &str, artist: &str| {
            let mut raw = RawTrack::default();
            raw.fields
                .insert("Track ID".to_string(), PlistValue::Int(tid));
            raw.fields
                .insert("Name".to_string(), PlistValue::Str(name.to_string()));
            raw.fields
                .insert("Artist".to_string(), PlistValue::Str(artist.to_string()));
            db.insert_track(
                &raw,
                "",
                true,
                &mut imported_persistent_ids,
                &mut imported_track_ids,
            )
            .unwrap();
        };
        mk(1, "さくら", "ＡＢＣ"); // ひらがな + 全角英字
        mk(2, "桜の歌", "圖書館"); // 繁体字を含む

        // insert で search_text が NULL でないこと。
        let st: Option<String> = db
            .conn
            .query_row(
                "SELECT search_text FROM tracks WHERE track_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(st.is_some() && !st.unwrap().is_empty());

        // カタカナで検索 → ひらがなの曲にヒット (字体ゆれ吸収)。
        let hits = db.search_tracks("サクラ", 100, 0, None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].track_id, 1);

        // 半角英字 (小文字) で全角 ＡＢＣ にヒット。
        let hits = db.search_tracks("abc", 100, 0, None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].track_id, 1);

        // 簡体字 图 で繁体字 圖 にヒット (Standard の漢字フォールド)。
        let hits = db.search_tracks("图书馆", 100, 0, None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].track_id, 2);
    }

    /// update_track / genre タグ更新で search_text が再計算され、新しい値で検索できること。
    #[test]
    fn search_text_recomputed_on_update() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, file_exists) VALUES (1, 'old', 1)",
                [],
            )
            .unwrap();
        // 直 INSERT は search_text が NULL のまま → 起動時バックフィルが無いインメモリでも
        // recompute されるのは update 経路。まず明示的に埋めるため update_track を使う。
        let edit = crate::models::TrackEdit {
            name: Some("みどり".to_string()),
            ..Default::default()
        };
        db.update_track(1, &edit).unwrap();
        // カタカナで検索 → 更新後の名前にヒット。
        assert_eq!(
            db.search_tracks("ミドリ", 100, 0, None, None)
                .unwrap()
                .len(),
            1
        );
        // 古い名前ではヒットしない。
        assert_eq!(
            db.search_tracks("old", 100, 0, None, None).unwrap().len(),
            0
        );

        // genre タグ追加でも search_text が更新される。
        db.add_genre_tag(1, "ハウス").unwrap();
        assert_eq!(
            db.search_tracks("はうす", 100, 0, None, None)
                .unwrap()
                .len(),
            1
        );
    }

    /// Rust 側 compute_search_text と SQL 側 SEARCH_TEXT_EXPR が一致すること
    /// (両者がズレると insert と backfill/recompute で別の値になり検索が破綻する)。
    #[test]
    fn compute_search_text_matches_sql_expr() {
        let db = Database::open_memory().unwrap();
        let rust_val = compute_search_text([
            Some("Sakura"),
            Some("サクラ"),
            None,
            Some("圖書館"),
            Some("House"),
            None,
        ]);
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, artist, album, album_artist, genre, comments, file_exists)
                 VALUES (1, 'Sakura', 'サクラ', NULL, '圖書館', 'House', NULL, 1)",
                [],
            )
            .unwrap();
        let sql_val: String = db
            .conn
            .query_row(
                &format!(
                    "SELECT {} FROM tracks WHERE track_id = 1",
                    super::SEARCH_TEXT_EXPR
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rust_val, sql_val);
    }

    /// フィールド検索のテスト用ライブラリ。artist/album/genre/year/rating/comments を
    /// 一通り持たせ、track 1 のみ解析済み (track_analysis 行あり) にする。
    fn fielded_db() -> Database {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO tracks
                   (track_id, name, artist, album, album_artist, genre, year, rating, comments, file_exists)
                 VALUES
                   (1,'One More Time','Daft Punk','Discovery','Daft Punk','House',2001,100,'club classic',1),
                   (2,'Around the World','Daft Punk','Homework','Daft Punk','House',1997,80,'early single',1),
                   (3,'Windowlicker','Aphex Twin','Windowlicker','Aphex Twin','IDM',1999,NULL,'weird',1),
                   (4,'さくら','ＡＢＣ','Spring','ABC Band','J-Pop',2015,40,'メモ',1);
                 INSERT INTO track_analysis (persistent_id, track_id, version, bpm, key_camelot, energy)
                 VALUES ('P1', 1, 1, 123.0, '8A', 0.8);",
            )
            .unwrap();
        db
    }

    fn ids(db: &Database, q: &str) -> Vec<i64> {
        let mut v: Vec<i64> = db
            .search_tracks(q, 100, 0, None, None)
            .unwrap()
            .into_iter()
            .map(|t| t.track_id)
            .collect();
        v.sort_unstable();
        v
    }

    /// テキスト系フィールド (artist/album/albumartist/genre/comment) の部分一致。
    /// 引用符付きの値と、フリーテキストとの AND 結合も確認する。
    #[test]
    fn fielded_text_operators() {
        let db = fielded_db();
        assert_eq!(ids(&db, "artist:\"daft punk\""), vec![1, 2]);
        assert_eq!(ids(&db, "artist:daft"), vec![1, 2]);
        assert_eq!(ids(&db, "album:homework"), vec![2]);
        assert_eq!(ids(&db, "albumartist:aphex"), vec![3]);
        assert_eq!(ids(&db, "album_artist:aphex"), vec![3]);
        assert_eq!(ids(&db, "genre:idm"), vec![3]);
        assert_eq!(ids(&db, "comment:classic"), vec![1]);
        // フィールド指定同士 / フリーテキストとの AND。
        assert_eq!(ids(&db, "artist:\"daft punk\" album:discovery"), vec![1]);
        assert_eq!(ids(&db, "artist:daft world"), vec![2]);
        // 値が空のトークンはフィールド指定として扱わない (フリーテキスト扱いで 0 件)。
        assert!(ids(&db, "artist:").is_empty());
    }

    /// テキスト系フィールドもフリーテキストと同じ fold レベルで比較されること
    /// (既定 Standard: 全角/半角・ひらがな/カタカナのゆれを吸収)。
    #[test]
    fn fielded_text_operators_fold_variants() {
        let db = fielded_db();
        assert_eq!(ids(&db, "artist:abc"), vec![4]); // 半角 abc → 全角 ＡＢＣ
        assert_eq!(ids(&db, "name:サクラ"), Vec::<i64>::new()); // name: は未対応 → フリーテキスト
        assert_eq!(ids(&db, "genre:j-pop"), vec![4]);
    }

    /// year: は単一値と範囲 (2015-2020) の両方を受ける。
    #[test]
    fn fielded_year_operator() {
        let db = fielded_db();
        assert_eq!(ids(&db, "year:1997"), vec![2]);
        assert_eq!(ids(&db, "year:1997-2001"), vec![1, 2, 3]);
        assert_eq!(ids(&db, "year:2010-2020"), vec![4]);
        // 範囲の左右が逆でも同じ結果。
        assert_eq!(ids(&db, "year:2001-1997"), vec![1, 2, 3]);
    }

    /// rating: は星 (0..5) で受け、0..100 の rating 列に写す。未評価は 0 星。
    #[test]
    fn fielded_rating_operator() {
        let db = fielded_db();
        assert_eq!(ids(&db, "rating:5"), vec![1]);
        assert_eq!(ids(&db, "rating:4"), vec![2]);
        assert_eq!(ids(&db, "rating:4-5"), vec![1, 2]);
        assert_eq!(ids(&db, "rating:2"), vec![4]);
        assert_eq!(ids(&db, "rating:0"), vec![3]); // 未評価 (NULL)
        // 範囲外の星はフィールド指定として扱わない → フリーテキスト扱いで 0 件。
        assert!(ids(&db, "rating:9").is_empty());
    }

    /// analyzed: yes/no で track_analysis 行の有無を絞り込む。
    #[test]
    fn fielded_analyzed_operator() {
        let db = fielded_db();
        assert_eq!(ids(&db, "analyzed:yes"), vec![1]);
        assert_eq!(ids(&db, "analyzed:no"), vec![2, 3, 4]);
        assert_eq!(ids(&db, "analyzed:true"), vec![1]);
        assert_eq!(ids(&db, "analyzed:0"), vec![2, 3, 4]);
        // 既存の bpm:/key:/energy: が引き続き効くこと。
        assert_eq!(ids(&db, "bpm:120-128"), vec![1]);
        assert_eq!(ids(&db, "key:8a"), vec![1]);
        assert_eq!(ids(&db, "energy:75-85"), vec![1]);
    }

    /// key:compat:<camelot> がハーモニック互換キー (同キー / 平行調 / ホイール ±1) を
    /// まとめて拾うこと。互換判定は analyzer::similarity::camelot_compatible と同じ。
    #[test]
    fn key_compat_operator() {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO tracks (track_id, name, file_exists) VALUES
                   (1,'same 8A',1), (2,'relative 8B',1), (3,'down 7A',1),
                   (4,'up 9A',1), (5,'far 2A',1), (6,'other mode 9B',1),
                   (7,'wrap 12A',1), (8,'unanalyzed',1);
                 INSERT INTO track_analysis (persistent_id, track_id, version, key_camelot) VALUES
                   ('P1',1,1,'8A'), ('P2',2,1,'8B'), ('P3',3,1,'7A'), ('P4',4,1,'9A'),
                   ('P5',5,1,'2A'), ('P6',6,1,'9B'), ('P7',7,1,'12A');",
            )
            .unwrap();
        // 8A: 8A / 8B (平行調) / 7A / 9A (±1 同種)。9B は同種でも隣接でもないので除外。
        assert_eq!(ids(&db, "key:compat:8A"), vec![1, 2, 3, 4]);
        // 小文字でも同じ。
        assert_eq!(ids(&db, "key:compat:8a"), vec![1, 2, 3, 4]);
        // ホイールの折り返し: 1A の隣は 12A と 2A。
        assert_eq!(ids(&db, "key:compat:1A"), vec![5, 7]);
        // 単一キー指定 (従来) は互換キーへ広がらない。
        assert_eq!(ids(&db, "key:8A"), vec![1]);
        // 解釈できない Camelot はフィールド指定にならずフリーテキスト扱い → 0 件。
        assert!(ids(&db, "key:compat:99Z").is_empty());
    }

    /// 互換キー集合そのものの単体確認 (SQL を介さない)。
    #[test]
    fn compatible_camelot_keys_set() {
        use super::compatible_camelot_keys;
        let mut k = compatible_camelot_keys("8A").unwrap();
        k.sort();
        assert_eq!(k, vec!["7A", "8A", "8B", "9A"]);
        let mut k = compatible_camelot_keys("12b").unwrap();
        k.sort();
        assert_eq!(k, vec!["11B", "12A", "12B", "1B"]);
        assert!(compatible_camelot_keys("13A").is_none());
        assert!(compatible_camelot_keys("").is_none());
    }

    /// フィールド値は必ずバインドされ、SQL に埋め込まれないこと (インジェクション防止)。
    #[test]
    fn fielded_values_are_parameterized() {
        let db = fielded_db();
        assert!(ids(&db, "artist:\"'; DROP TABLE tracks; --\"").is_empty());
        assert!(ids(&db, "genre:\"' OR 1=1 --\"").is_empty());
        // tracks テーブルが健在で、通常の検索も動くこと。
        assert_eq!(ids(&db, "artist:aphex"), vec![3]);
    }

    /// 引用符を含むクエリのトークン分割。
    #[test]
    fn tokenize_query_handles_quotes() {
        use super::tokenize_query;
        assert_eq!(
            tokenize_query("artist:\"daft punk\" house"),
            vec!["artist:daft punk", "house"]
        );
        assert_eq!(tokenize_query("  a   b  "), vec!["a", "b"]);
        // 閉じ引用符が無い場合は行末までを 1 トークンにする。
        assert_eq!(tokenize_query("artist:\"daft punk"), vec!["artist:daft punk"]);
    }

    /// prefix 無しの search_text_expr が定数 SEARCH_TEXT_EXPR と完全一致すること
    /// (ズレるとバックフィルと検索フォールバックで別の値になる)。
    #[test]
    fn search_text_expr_matches_const() {
        assert_eq!(super::search_text_expr(""), super::SEARCH_TEXT_EXPR);
    }

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
            (13, Some(""), None), // 空 album → 除外
            (14, None, None),     // NULL album → 除外
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

        let albums = db.get_albums_legacy().unwrap();
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

    /// get_artists は grouping ごとに表示名でグループ化し、track_count と最小 track_id を返す。
    /// 表示名フォールバック (artist→album_artist→Unknown / album_artist→artist→Unknown) と
    /// 空文字="" の扱い (falsy=次へ)、表示名 NOCASE 昇順を検証する。
    #[test]
    fn get_artists_groups_by_display_name() {
        let db = Database::open_memory().unwrap();
        let rows = [
            // (track_id, artist, album_artist)
            (10, Some("Beta"), Some("VA")), // artist=Beta / album_artist=VA
            (11, Some("Beta"), Some("VA")), // 同 artist=Beta、別 album_artist と組み合わせ
            (12, Some("alpha"), Some("alpha")),
            (13, Some(""), Some("Comp AA")), // artist 空 → grouping=artist では album_artist にフォールバック
            (14, None, None),                // 両方無し → "Unknown Artist"
        ];
        for (tid, artist, aa) in rows {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, artist, album_artist, file_exists)
                     VALUES (?1, ?2, ?3, ?4, 1)",
                    rusqlite::params![tid, format!("t{tid}"), artist, aa],
                )
                .unwrap();
        }

        // grouping=artist: 表示名 = artist || album_artist || "Unknown Artist"。
        // 期待される表示名: "alpha"(12), "Beta"(10,11), "Comp AA"(13), "Unknown Artist"(14)。
        let artists = db.get_artists(false).unwrap();
        let names: Vec<&str> = artists.iter().map(|a| a.artist.as_str()).collect();
        // NOCASE 昇順: alpha, Beta, Comp AA, Unknown Artist。
        assert_eq!(names, vec!["alpha", "Beta", "Comp AA", "Unknown Artist"]);
        let beta = artists.iter().find(|a| a.artist == "Beta").unwrap();
        assert_eq!(beta.track_count, 2);
        assert_eq!(beta.sample_track_id, 10);
        let comp = artists.iter().find(|a| a.artist == "Comp AA").unwrap();
        assert_eq!(comp.track_count, 1);
        assert_eq!(comp.sample_track_id, 13);
        let unknown = artists
            .iter()
            .find(|a| a.artist == "Unknown Artist")
            .unwrap();
        assert_eq!(unknown.track_count, 1);
        assert_eq!(unknown.sample_track_id, 14);

        // grouping=albumArtist: 表示名 = album_artist || artist || "Unknown Artist"。
        // 期待: "alpha"(12), "Comp AA"(13), "Unknown Artist"(14), "VA"(10,11)。
        let aas = db.get_artists(true).unwrap();
        let names: Vec<&str> = aas.iter().map(|a| a.artist.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Comp AA", "Unknown Artist", "VA"]);
        let va = aas.iter().find(|a| a.artist == "VA").unwrap();
        assert_eq!(va.track_count, 2);
        assert_eq!(va.sample_track_id, 10);
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

    // ────────────────────────────────────────────────────────────────
    // AlbumRow 集約クエリのテスト
    // ────────────────────────────────────────────────────────────────

    /// コンピレーション束ね: compilation=1・同じアルバム・アーティストが曲ごとに異なる3曲
    /// → get_albums が1行、track_count=3、album_artist="Various Artists"、is_compilation=true。
    #[test]
    fn album_row_compilation_bundled() {
        let db = Database::open_memory().unwrap();
        for (tid, artist) in [(100i64, "ArtistA"), (101, "ArtistB"), (102, "ArtistC")] {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, artist, album, compilation, file_exists, track_number)
                     VALUES (?1, ?2, ?3, 'Greatest Hits', 1, 1, ?4)",
                    rusqlite::params![tid, format!("t{tid}"), artist, tid - 99],
                )
                .unwrap();
        }
        let albums = db.get_albums(None, None, 100, 0).unwrap();
        assert_eq!(albums.len(), 1, "コンピは1行に束ねられるべき");
        let a = &albums[0];
        assert_eq!(a.track_count, 3);
        assert_eq!(a.album_artist, "Various Artists");
        assert!(a.is_compilation);
        assert!(a.album_key.starts_with("cmp:"));
    }

    /// 通常アルバム: 同じ album_artist + album の複数曲 → 1行に束ねる。
    #[test]
    fn album_row_normal_album_bundled() {
        let db = Database::open_memory().unwrap();
        for tid in [200i64, 201, 202] {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, artist, album_artist, album, file_exists, track_number)
                     VALUES (?1, ?2, 'SameArtist', 'SameArtist', 'SameAlbum', 1, ?3)",
                    rusqlite::params![tid, format!("t{tid}"), tid - 199],
                )
                .unwrap();
        }
        let albums = db.get_albums(None, None, 100, 0).unwrap();
        assert_eq!(albums.len(), 1, "通常アルバムは1行に束ねられるべき");
        assert_eq!(albums[0].track_count, 3);
        assert!(albums[0].album_key.starts_with("al:"));
    }

    /// 空 album: album が空の2曲はそれぞれ別行(tr: キー)になる。
    #[test]
    fn album_row_empty_album_separate() {
        let db = Database::open_memory().unwrap();
        for tid in [300i64, 301] {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, album, file_exists)
                     VALUES (?1, ?2, '', 1)",
                    rusqlite::params![tid, format!("t{tid}")],
                )
                .unwrap();
        }
        let albums = db.get_albums(None, None, 100, 0).unwrap();
        assert_eq!(albums.len(), 2, "空albumの曲はそれぞれ別行になるべき");
        assert!(albums.iter().all(|a| a.album_key.starts_with("tr:")));
    }

    /// 空 albumArtist 非コンピ: album_artist 空・artist 同じ・album 同じ → artist にフォールバックして1行。
    #[test]
    fn album_row_fallback_to_artist() {
        let db = Database::open_memory().unwrap();
        for tid in [400i64, 401] {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, artist, album_artist, album, file_exists, track_number)
                     VALUES (?1, ?2, 'SoloArtist', '', 'SoloAlbum', 1, ?3)",
                    rusqlite::params![tid, format!("t{tid}"), tid - 399],
                )
                .unwrap();
        }
        let albums = db.get_albums(None, None, 100, 0).unwrap();
        assert_eq!(albums.len(), 1, "artistフォールバックで1行に束ねられるべき");
        assert_eq!(albums[0].track_count, 2);
        // album_key に artist 名が含まれること。
        assert!(albums[0].album_key.contains("soloartist"));
    }

    /// multi-disc 並び: get_album_tracks が disc1→disc2 の順(disc_number昇順→track_number昇順)になる。
    #[test]
    fn album_tracks_multi_disc_order() {
        let db = Database::open_memory().unwrap();
        // disc2の曲を先に挿入してもdiscの昇順で並ぶことを確認。
        let rows = [
            // (track_id, disc_number, track_number)
            (500i64, 2i64, 1i64),
            (501, 2, 2),
            (502, 1, 1),
            (503, 1, 2),
        ];
        for (tid, disc, tnum) in rows {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, artist, album_artist, album, disc_number, track_number, file_exists)
                     VALUES (?1, ?2, 'A', 'A', 'MultiDisc', ?3, ?4, 1)",
                    rusqlite::params![tid, format!("t{tid}"), disc, tnum],
                )
                .unwrap();
        }
        // まず get_albums でアルバムキーを取得。
        let albums = db.get_albums(None, None, 100, 0).unwrap();
        assert_eq!(albums.len(), 1);
        let key = &albums[0].album_key;

        let tracks = db.get_album_tracks(key).unwrap();
        assert_eq!(tracks.len(), 4);
        // disc1-track1, disc1-track2, disc2-track1, disc2-track2 の順。
        assert_eq!(tracks[0].track_id, 502); // disc1 track1
        assert_eq!(tracks[1].track_id, 503); // disc1 track2
        assert_eq!(tracks[2].track_id, 500); // disc2 track1
        assert_eq!(tracks[3].track_id, 501); // disc2 track2
    }
}
