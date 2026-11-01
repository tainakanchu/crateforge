//! Rules の条件 DSL / ソート指定 → スマートプレイリスト条件 ([`SmartCriteria`]) への変換。
//!
//! Rules の評価セマンティクス (旧静的評価器と同じ) をスマート評価で正確に再現する:
//! - フィールド条件は最初に書かれている演算子だけを使う
//!   (exists > equals > contains > in > gt > gte > lt > lte)。演算子が 1 つも無ければ常に偽。
//! - 値が無い曲は、exists 以外の肯定条件をすべて満たさない。その `not` は満たす。
//!   スマート側は isNot / notContains だけが値なしで真になるので、`not` は De Morgan で
//!   葉まで押し下げ、大小比較の否定は `any(逆の比較, 値なし)` にする。
//! - rating は Rules では 0-100、スマートでは星 (0-5、0.5 刻み) なので値を 1/20 にする。
//!
//! ここは DB に触らない純粋関数のまま保つ (プレイリスト参照の解決は呼び出し側のクロージャ)。

use crate::models::{SmartCriteria, SmartGroup, SmartOp, SmartRule, SmartSortKey};
use crate::smart::{self, PLAYLIST_FIELD};

use super::schema::{Condition, FieldCondition, PlaylistRef, PlaylistRule, SortOrder, SortRule};

/// bool 値を持つフィールド (スマート側では 1 / 0 の数値)。
const BOOL_FIELDS: &[&str] = &["compilation", "disabled"];

/// 変換途中のノード。定数は畳み込みで消す。
#[derive(Debug, Clone, PartialEq)]
enum Node {
    Rule(SmartRule),
    Group(SmartGroup),
    /// 常に真 / 常に偽 (空の all / any、演算子なし、解決できない参照など)。
    Const(bool),
}

/// プレイリスト参照の解決結果。`Err` は警告に載せる理由 (条件は「一致しない」扱い)。
pub type RefResolution = Result<String, String>;

/// 1 ルール (プレイリスト) 分の変換器。警告は `"<path>: ..."` の形で積む。
struct Converter<'a> {
    path: &'a str,
    resolve: &'a mut dyn FnMut(&PlaylistRef) -> RefResolution,
    warnings: &'a mut Vec<String>,
}

/// PlaylistRule 1 つをスマート条件に変換する (match + sort)。
pub fn rule_to_criteria(
    rule: &PlaylistRule,
    resolve: &mut dyn FnMut(&PlaylistRef) -> RefResolution,
    warnings: &mut Vec<String>,
) -> SmartCriteria {
    let mut conv = Converter {
        path: &rule.name,
        resolve,
        warnings,
    };
    let node = conv.condition(&rule.match_, false);
    let mut criteria = into_criteria(node);
    let (sort_by, sort_desc, then_by) = conv.sort(rule.sort.as_deref().unwrap_or(&[]));
    criteria.sort_by = sort_by;
    criteria.sort_desc = sort_desc;
    criteria.then_by = then_by;
    criteria
}

fn rule(field: &str, op: SmartOp, value: impl Into<String>) -> Node {
    Node::Rule(SmartRule {
        field: field.to_string(),
        op,
        value: value.into(),
    })
}

/// 常に偽になるルール (trackId は必ずあるので「値なし」は誰にも当てはまらない)。
fn never_rule() -> SmartRule {
    SmartRule {
        field: "trackId".to_string(),
        op: SmartOp::NotExists,
        value: String::new(),
    }
}

/// 子を結合方法で畳み込む。定数は短絡・除去し、子が 1 つなら引き上げ、同じ結合方法の
/// 子グループは親に平坦化する (iTunes 取り込みの `smart_criteria::fold` と同じ考え方)。
fn fold(match_all: bool, children: Vec<Node>) -> Node {
    let mut nodes = Vec::new();
    for child in children {
        match child {
            // ALL に偽 / ANY に真があれば全体が決まる。もう一方の定数は影響しないので除く。
            Node::Const(v) if v != match_all => return Node::Const(v),
            Node::Const(_) => {}
            node => nodes.push(node),
        }
    }
    if nodes.is_empty() {
        // 空の all は真、空の any は偽 (Rules の評価と同じ)。
        return Node::Const(match_all);
    }
    if nodes.len() == 1 {
        return nodes.pop().expect("one node");
    }
    let mut group = SmartGroup {
        match_all,
        rules: Vec::new(),
        groups: Vec::new(),
    };
    for node in nodes {
        match node {
            Node::Rule(r) => group.rules.push(r),
            Node::Group(child) if child.match_all == match_all => {
                group.rules.extend(child.rules);
                group.groups.extend(child.groups);
            }
            Node::Group(child) => group.groups.push(child),
            Node::Const(_) => {}
        }
    }
    Node::Group(group)
}

/// 最上位ノードを SmartCriteria にする (並び替えは呼び出し側で埋める)。
fn into_criteria(node: Node) -> SmartCriteria {
    let (match_all, rules, groups) = match node {
        Node::Rule(r) => (true, vec![r], Vec::new()),
        Node::Group(g) => (g.match_all, g.rules, g.groups),
        // ルールなし = 全曲。
        Node::Const(true) => (true, Vec::new(), Vec::new()),
        Node::Const(false) => (true, vec![never_rule()], Vec::new()),
    };
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

/// 数値の文字列化 (整数なら小数点なし: 128.0 → "128")。
fn format_number(v: f64) -> String {
    format!("{v}")
}

impl Converter<'_> {
    fn warn(&mut self, msg: String) {
        let line = format!("{}: {}", self.path, msg);
        if !self.warnings.contains(&line) {
            self.warnings.push(line);
        }
    }

    /// 条件を変換する。`negate` が真なら否定した条件を作る (De Morgan で葉まで押し下げる)。
    fn condition(&mut self, c: &Condition, negate: bool) -> Node {
        match c {
            // not all = any of nots / not any = all of nots。
            Condition::All { all } => {
                let children = all.iter().map(|c| self.condition(c, negate)).collect();
                fold(!negate, children)
            }
            Condition::Any { any } => {
                let children = any.iter().map(|c| self.condition(c, negate)).collect();
                fold(negate, children)
            }
            // not not x = x。
            Condition::Not { not } => self.condition(not, !negate),
            Condition::InPlaylist { in_playlist } => self.in_playlist(in_playlist, negate),
            Condition::Field(f) => self.field(f, negate),
        }
    }

    fn in_playlist(&mut self, r: &PlaylistRef, negate: bool) -> Node {
        match (self.resolve)(r) {
            Ok(pid) => rule(
                PLAYLIST_FIELD,
                if negate { SmartOp::IsNot } else { SmartOp::Is },
                pid,
            ),
            Err(reason) => {
                // 旧評価器と同じく、解決できない参照は「どの曲も含まない」扱い。
                self.warn(format!("{reason}; the inPlaylist condition never matches"));
                Node::Const(negate)
            }
        }
    }

    fn field(&mut self, c: &FieldCondition, negate: bool) -> Node {
        let field = c.field.as_str();
        if !smart::FIELDS.contains(&field) {
            self.warn(format!(
                "unknown field \"{field}\"; it is treated as always empty"
            ));
        }

        // exists は値の有無だけを見る (否定は反対の有無)。
        if let Some(should_exist) = c.exists {
            let op = if should_exist != negate {
                SmartOp::Exists
            } else {
                SmartOp::NotExists
            };
            return rule(field, op, "");
        }

        // equals: 値なしは偽、その否定 (isNot) は値なしで真なのでそのまま対応する。
        if let Some(expected) = &c.equals {
            return match self.value(field, expected) {
                Some(v) => rule(field, if negate { SmartOp::IsNot } else { SmartOp::Is }, v),
                None => Node::Const(negate),
            };
        }

        if let Some(needle) = &c.contains {
            if field == "rating" {
                self.warn(
                    "\"contains\" on rating is evaluated against stars (0-5), not 0-100".into(),
                );
            }
            let op = if negate {
                SmartOp::NotContains
            } else {
                SmartOp::Contains
            };
            return rule(field, op, needle.clone());
        }

        // in [a, b] = any(is a, is b)。否定は all(isNot a, isNot b) (値なしでも真)。
        if let Some(list) = &c.in_ {
            let op = if negate { SmartOp::IsNot } else { SmartOp::Is };
            let children = list
                .iter()
                .filter_map(|item| self.value(field, item))
                .map(|v| rule(field, op, v))
                .collect();
            return fold(negate, children);
        }

        // 大小比較の否定は「逆の比較 or 値なし」(Rules では値なしの比較は偽 → その否定は真)。
        let comparisons = [
            (c.gt, SmartOp::Gt, SmartOp::Lte),
            (c.gte, SmartOp::Gte, SmartOp::Lt),
            (c.lt, SmartOp::Lt, SmartOp::Gte),
            (c.lte, SmartOp::Lte, SmartOp::Gt),
        ];
        for (bound, op, negated_op) in comparisons {
            let Some(bound) = bound else { continue };
            let v = self.number(field, bound);
            if !negate {
                return rule(field, op, v);
            }
            return fold(
                false,
                vec![
                    rule(field, negated_op, v),
                    rule(field, SmartOp::NotExists, ""),
                ],
            );
        }

        self.warn(format!(
            "condition on field \"{field}\" has no operator; it never matches"
        ));
        Node::Const(negate)
    }

    /// 数値の境界値を文字列化する (rating は 0-100 → 星)。
    fn number(&mut self, field: &str, v: f64) -> String {
        if field != "rating" {
            return format_number(v);
        }
        if v % 10.0 != 0.0 {
            self.warn(format!(
                "rating {} is not a multiple of 10; smart playlists compare ratings in half stars, \
                 so tracks near this boundary may be matched differently",
                format_number(v)
            ));
        }
        format_number(v / 20.0)
    }

    /// equals / in の YAML スカラーを比較値の文字列にする。比較できない値 (配列など) は None。
    fn value(&mut self, field: &str, v: &serde_yaml::Value) -> Option<String> {
        match v {
            serde_yaml::Value::Bool(b) if BOOL_FIELDS.contains(&field) => {
                Some(if *b { "1" } else { "0" }.to_string())
            }
            serde_yaml::Value::Bool(b) => Some(b.to_string()),
            serde_yaml::Value::Number(n) => {
                let f = n.as_f64()?;
                Some(self.number(field, f))
            }
            serde_yaml::Value::String(s) => Some(s.clone()),
            // null は旧評価器でも何にも一致しない。
            serde_yaml::Value::Null => None,
            other => {
                self.warn(format!(
                    "unsupported value {other:?} for field \"{field}\"; it never matches"
                ));
                None
            }
        }
    }

    /// Rules の複数キーソート → (sort_by, sort_desc, then_by)。
    fn sort(&mut self, keys: &[SortRule]) -> (Option<String>, bool, Vec<SmartSortKey>) {
        for key in keys {
            if !smart::SORT_FIELDS.contains(&key.field.as_str()) {
                self.warn(format!(
                    "sort field \"{}\" is not supported; name order is used instead",
                    key.field
                ));
            }
        }
        let Some((first, rest)) = keys.split_first() else {
            return (None, false, Vec::new());
        };
        let then_by = rest
            .iter()
            .map(|k| SmartSortKey {
                field: k.field.clone(),
                desc: k.order == SortOrder::Desc,
            })
            .collect();
        (
            Some(first.field.clone()),
            first.order == SortOrder::Desc,
            then_by,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::models::Track;
    use crate::playlist_rules::generator::expand_generators;
    use crate::playlist_rules::schema::{parse_rules_yaml, PlaylistSource};
    use crate::smart::{track_matches, EvalContext};
    use crate::text_fold::FoldLevel;

    fn r(field: &str, op: SmartOp, value: &str) -> SmartRule {
        SmartRule {
            field: field.into(),
            op,
            value: value.into(),
        }
    }

    /// YAML の `playlists` を変換する。参照は generated → "G:<name>"、existing → "E:<name>"、
    /// existing の "missing" だけ解決失敗。
    fn convert_all(yaml: &str) -> (Vec<SmartCriteria>, Vec<String>) {
        let file = parse_rules_yaml(yaml).unwrap();
        let mut rules = file.playlists.clone();
        rules.extend(
            expand_generators(
                &file.generators,
                &file.templates.clone().unwrap_or_default(),
            )
            .unwrap(),
        );
        let mut warnings = Vec::new();
        let mut resolve = |r: &PlaylistRef| match (r.source, r.name.as_str()) {
            (PlaylistSource::Existing, "missing") => {
                Err("existing playlist \"missing\" not found".to_string())
            }
            (PlaylistSource::Existing, n) => Ok(format!("E:{n}")),
            (PlaylistSource::Generated, n) => Ok(format!("G:{n}")),
        };
        let out = rules
            .iter()
            .map(|rule| rule_to_criteria(rule, &mut resolve, &mut warnings))
            .collect();
        (out, warnings)
    }

    fn convert_one(match_yaml: &str) -> (SmartCriteria, Vec<String>) {
        let indented = match_yaml
            .lines()
            .map(|l| format!("      {l}"))
            .collect::<Vec<_>>()
            .join("\n");
        let yaml = format!("namespace: N\nplaylists:\n  - name: P\n    match:\n{indented}\n");
        let (mut v, w) = convert_all(&yaml);
        (v.remove(0), w)
    }

    fn track(id: i64) -> Track {
        let mut t: Track = serde_json::from_value(serde_json::json!({
            "id": id, "trackId": id, "persistentId": null, "name": null, "artist": null,
            "albumArtist": null, "composer": null, "album": null, "genre": null, "year": null,
            "rating": null, "playCount": null, "skipCount": null, "totalTimeMs": null,
            "dateAdded": null, "dateModified": null, "bpm": null, "comments": null,
            "locationRaw": null, "locationPath": null, "trackType": null, "disabled": false,
            "compilation": false, "discNumber": null, "discCount": null, "trackNumber": null,
            "trackCount": null, "fileExists": true, "lastPlayed": null, "bitrateKbps": null,
            "sampleRateHz": null, "bitDepth": null, "channels": null, "fileSizeBytes": null,
            "codec": null, "keyCamelotUser": null, "grouping": null
        }))
        .unwrap();
        t.track_id = id;
        t
    }

    fn matches(t: &Track, c: &SmartCriteria) -> bool {
        let membership = HashMap::new();
        track_matches(
            t,
            None,
            c,
            &EvalContext {
                level: FoldLevel::Standard,
                membership: &membership,
            },
        )
    }

    #[test]
    fn positive_leaves() {
        let (c, w) = convert_one(
            "all:\n  - field: genre\n    equals: House\n  - field: artist\n    contains: daft\n  - field: bpm\n    gte: 120\n  - field: year\n    lt: 2010\n  - field: comments\n    exists: true\n  - inPlaylist:\n      source: existing\n      name: Base",
        );
        assert!(w.is_empty(), "{w:?}");
        assert!(c.match_all);
        assert!(c.groups.is_empty());
        assert_eq!(
            c.rules,
            vec![
                r("genre", SmartOp::Is, "House"),
                r("artist", SmartOp::Contains, "daft"),
                r("bpm", SmartOp::Gte, "120"),
                r("year", SmartOp::Lt, "2010"),
                r("comments", SmartOp::Exists, ""),
                r(PLAYLIST_FIELD, SmartOp::Is, "E:Base"),
            ]
        );
        assert_eq!(c.sort_by, None);
    }

    /// 単独の葉は 1 ルールの match_all になる。in は any of is。
    #[test]
    fn bare_leaf_and_in() {
        let (c, _) = convert_one("field: genre\nin: [House, Techno]");
        assert!(!c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("genre", SmartOp::Is, "House"),
                r("genre", SmartOp::Is, "Techno")
            ]
        );
        let (c, _) = convert_one("field: bpm\ngt: 128.5");
        assert!(c.match_all);
        assert_eq!(c.rules, vec![r("bpm", SmartOp::Gt, "128.5")]);
    }

    /// not は De Morgan で葉まで押し下げる。
    #[test]
    fn negation_de_morgan() {
        // not all[a, b] = any[not a, not b]
        let (c, _) = convert_one(
            "not:\n  all:\n    - field: genre\n      equals: House\n    - field: artist\n      contains: daft",
        );
        assert!(!c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("genre", SmartOp::IsNot, "House"),
                r("artist", SmartOp::NotContains, "daft"),
            ]
        );
        // not any[a, in[x, y]] = all[not a, isNot x, isNot y] (同じ結合は平坦化)。
        let (c, _) = convert_one(
            "not:\n  any:\n    - field: genre\n      equals: House\n    - field: artist\n      in: [X, Y]",
        );
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("genre", SmartOp::IsNot, "House"),
                r("artist", SmartOp::IsNot, "X"),
                r("artist", SmartOp::IsNot, "Y"),
            ]
        );
        // not not x = x
        let (c, _) = convert_one("not:\n  not:\n    field: genre\n    equals: House");
        assert_eq!(c.rules, vec![r("genre", SmartOp::Is, "House")]);
        // 大小比較の否定は any(逆の比較, 値なし)。exists の否定は反対の有無。
        let (c, _) = convert_one(
            "all:\n  - not:\n      field: bpm\n      gt: 120\n  - not:\n      field: comments\n      exists: true\n  - not:\n      inPlaylist:\n        source: generated\n        name: Base",
        );
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("comments", SmartOp::NotExists, ""),
                r(PLAYLIST_FIELD, SmartOp::IsNot, "G:Base"),
            ]
        );
        assert_eq!(
            c.groups,
            vec![SmartGroup {
                match_all: false,
                rules: vec![
                    r("bpm", SmartOp::Lte, "120"),
                    r("bpm", SmartOp::NotExists, "")
                ],
                groups: vec![],
            }]
        );
        for (op, neg) in [
            ("gte", SmartOp::Lt),
            ("lt", SmartOp::Gte),
            ("lte", SmartOp::Gt),
        ] {
            let (c, _) = convert_one(&format!("not:\n  field: bpm\n  {op}: 100"));
            assert!(!c.match_all);
            assert_eq!(
                c.rules,
                vec![r("bpm", neg, "100"), r("bpm", SmartOp::NotExists, "")]
            );
        }
    }

    /// 値なしの曲に対する not の結果が Rules (値なしの肯定条件は偽 → not は真) と一致する。
    #[test]
    fn negation_missing_value_equivalence() {
        let missing = track(1); // genre / bpm / comments すべて未設定
        let mut present = track(2);
        present.genre = Some("House".into());
        present.bpm = Some(124);
        present.comments = Some("x".into());
        let cases = [
            ("field: genre\nequals: House", false, true),
            ("field: genre\ncontains: hou", false, true),
            ("field: genre\nin: [House, Techno]", false, true),
            ("field: bpm\ngt: 120", false, true),
            ("field: bpm\ngte: 124", false, true),
            ("field: bpm\nlt: 125", false, true),
            ("field: bpm\nlte: 124", false, true),
            ("field: comments\nexists: true", false, true),
        ];
        for (leaf, missing_pos, present_pos) in cases {
            let (pos, _) = convert_one(leaf);
            let indented = leaf.replace('\n', "\n  ");
            let (neg, _) = convert_one(&format!("not:\n  {indented}"));
            assert_eq!(matches(&missing, &pos), missing_pos, "{leaf} (missing)");
            assert_eq!(
                matches(&missing, &neg),
                !missing_pos,
                "not {leaf} (missing)"
            );
            assert_eq!(matches(&present, &pos), present_pos, "{leaf} (present)");
            assert_eq!(
                matches(&present, &neg),
                !present_pos,
                "not {leaf} (present)"
            );
        }
    }

    /// rating は 0-100 → 星。10 の倍数でなければ警告。
    #[test]
    fn rating_is_converted_to_stars() {
        let (c, w) = convert_one("field: rating\ngte: 60");
        assert_eq!(c.rules, vec![r("rating", SmartOp::Gte, "3")]);
        assert!(w.is_empty());
        let (c, _) = convert_one("field: rating\nequals: 70");
        assert_eq!(c.rules, vec![r("rating", SmartOp::Is, "3.5")]);
        let (c, w) = convert_one("field: rating\ngt: 65");
        assert_eq!(c.rules, vec![r("rating", SmartOp::Gt, "3.25")]);
        assert_eq!(w.len(), 1);
        assert!(w[0].starts_with("P: rating 65"), "{w:?}");
        // 実際の評価: rating 80 (4 星) は gte 60 に一致、40 は不一致。
        let (c, _) = convert_one("field: rating\ngte: 60");
        let mut t = track(1);
        t.rating = Some(80);
        assert!(matches(&t, &c));
        t.rating = Some(40);
        assert!(!matches(&t, &c));
    }

    /// bool フィールドは 1 / 0、podcast は常に値なし。
    #[test]
    fn bool_fields() {
        let (c, _) = convert_one("field: compilation\nequals: true");
        assert_eq!(c.rules, vec![r("compilation", SmartOp::Is, "1")]);
        let (c, _) = convert_one("not:\n  field: disabled\n  equals: true");
        assert_eq!(c.rules, vec![r("disabled", SmartOp::IsNot, "1")]);
        let mut t = track(1);
        assert!(matches(&t, &c));
        t.disabled = true;
        assert!(!matches(&t, &c));
        let (c, w) = convert_one("field: podcast\nexists: false");
        assert!(w.is_empty());
        assert!(matches(&t, &c));
    }

    /// 演算子なし・未知フィールド・解決できない参照・空の any は警告つきで定数に畳む。
    #[test]
    fn constants_and_warnings() {
        let (c, w) = convert_one("field: genre");
        assert_eq!(c.rules, vec![never_rule()]);
        assert!(w[0].contains("no operator"), "{w:?}");
        assert!(!matches(&track(1), &c));

        let (c, w) = convert_one("field: mood\nequals: happy");
        assert_eq!(c.rules, vec![r("mood", SmartOp::Is, "happy")]);
        assert!(w[0].contains("unknown field \"mood\""), "{w:?}");

        // 解決できない参照は「どの曲も含まない」: 肯定は偽、否定は真。
        let (c, w) = convert_one("inPlaylist:\n  source: existing\n  name: missing");
        assert_eq!(c.rules, vec![never_rule()]);
        assert!(w[0].contains("never matches"), "{w:?}");
        let (c, _) = convert_one(
            "all:\n  - field: genre\n    equals: House\n  - not:\n      inPlaylist:\n        source: existing\n        name: missing",
        );
        assert_eq!(c.rules, vec![r("genre", SmartOp::Is, "House")]);

        // 空の all = 全曲、空の any = 一致なし。
        let (c, _) = convert_one("all: []");
        assert!(c.rules.is_empty() && c.groups.is_empty());
        let (c, _) = convert_one("any: []");
        assert_eq!(c.rules, vec![never_rule()]);
        // 演算子なしを any に混ぜても残りは生きる。
        let (c, _) = convert_one("any:\n  - field: genre\n  - field: bpm\n    gt: 1");
        assert_eq!(c.rules, vec![r("bpm", SmartOp::Gt, "1")]);
    }

    /// 演算子の優先順位は exists > equals > contains > in > gt > gte > lt > lte。
    #[test]
    fn operator_precedence() {
        let (c, _) = convert_one("field: genre\nequals: House\ncontains: Tech\nexists: false");
        assert_eq!(c.rules, vec![r("genre", SmartOp::NotExists, "")]);
        let (c, _) = convert_one("field: bpm\nlte: 140\ngte: 120");
        assert_eq!(c.rules, vec![r("bpm", SmartOp::Gte, "120")]);
    }

    /// 入れ子: all[a, any[b, c]] はグループ 1 つ、単一子グループは引き上げる。
    #[test]
    fn nesting_is_kept_readable() {
        let (c, _) = convert_one(
            "all:\n  - field: rating\n    gte: 60\n  - any:\n      - field: genre\n        equals: J-POP\n      - field: genre\n        equals: Anime\n  - all:\n      - any:\n          - field: bpm\n            gt: 100",
        );
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![r("rating", SmartOp::Gte, "3"), r("bpm", SmartOp::Gt, "100")]
        );
        assert_eq!(c.groups.len(), 1);
        assert!(!c.groups[0].match_all);
        assert_eq!(c.groups[0].rules.len(), 2);
    }

    /// 複数キーのソートは第 1 キー + then_by。未対応フィールドは警告。
    #[test]
    fn multi_key_sort() {
        let yaml = "namespace: N\nplaylists:\n  - name: P\n    match: {field: genre, equals: House}\n    sort:\n      - {field: artist, order: asc}\n      - {field: bpm, order: desc}\n      - {field: mood, order: asc}\n";
        let (v, w) = convert_all(yaml);
        let c = &v[0];
        assert_eq!(c.sort_by.as_deref(), Some("artist"));
        assert!(!c.sort_desc);
        assert_eq!(
            c.then_by,
            vec![
                SmartSortKey {
                    field: "bpm".into(),
                    desc: true
                },
                SmartSortKey {
                    field: "mood".into(),
                    desc: false
                },
            ]
        );
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("sort field \"mood\""));
    }

    /// generator で展開したルールもそのまま変換できる (source 参照 + 範囲)。
    #[test]
    fn generators_convert() {
        let yaml = "namespace: N\nplaylists:\n  - name: Fav\n    match: {field: rating, gte: 80}\ngenerators:\n  - type: bpmRange\n    basePath: BPM\n    sourcePlaylist: {source: generated, name: Fav}\n    from: 120\n    to: 130\n    step: 5\n    sort:\n      - {field: bpm, order: asc}\n";
        let (v, w) = convert_all(yaml);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].rules, vec![r("rating", SmartOp::Gte, "4")]);
        assert_eq!(
            v[1].rules,
            vec![
                r(PLAYLIST_FIELD, SmartOp::Is, "G:Fav"),
                r("bpm", SmartOp::Gte, "120"),
                r("bpm", SmartOp::Lt, "125"),
            ]
        );
        assert!(v[1].match_all);
        assert_eq!(v[2].rules[2], r("bpm", SmartOp::Lt, "130"));
        assert_eq!(v[2].sort_by.as_deref(), Some("bpm"));
    }
}
