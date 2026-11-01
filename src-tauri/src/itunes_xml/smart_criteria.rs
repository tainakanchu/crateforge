//! iTunes スマートプレイリスト条件 (`Smart Criteria` / `Smart Info` の `<data>`) のデコーダ。
//!
//! 実データ (iTunes for Windows 12.x の Library.xml) をバイト単位で確認した形式:
//!
//! - グループ: `"SLst"` + `00 01 00 01`、+8 に u32 BE のルール数、+12 に u32 BE の結合
//!   (1 = いずれか / 0 = すべて)。最初のルールは +136 から。
//! - ルール: +0 u32 BE フィールド ID、+4 符号 (0x00 数値・肯定 / 0x01 文字列・肯定 /
//!   0x02 数値・否定 / 0x03 文字列・否定)、+7 演算 (0x01 一致 / 0x02 含む / 0x04 前方 /
//!   0x08 後方 / 0x10 より大 / 0x40 より小 / 0x00 範囲 (日付なら相対指定))、+52 u32 BE で
//!   データ長、+56 からデータ。次のルールは +56+len。
//! - フィールド 0 はサブ条件で、データが入れ子の SLst グループ。
//! - 文字列データは UTF-16BE。数値データ (0x44 バイト) は data+0 に値1 (u64 BE)、data+24 に
//!   値2 (範囲の上限。それ以外は値1と同じ)、data+16 / data+40 は単位 (通常 1、相対日付では秒数)。
//! - プレイリスト (0x28) は data+0 の u64 を 16 桁の大文字 16 進にしたものが参照先の
//!   "Playlist Persistent ID"。
//! - Smart Info: byte0 ライブ更新、byte2 上限あり、byte3 上限の種類 (3 = 曲数)、
//!   bytes 4..8 上限の並び、bytes 8..12 上限値、byte13 並びを逆順。
//!
//! 変換できない条件は警告付きで落とす。落とした結果「全曲に一致」になってしまう場合は
//! 変換自体を失敗扱いにする (呼び出し側はそのプレイリストに条件を保存しない)。

use crate::models::{SmartCriteria, SmartGroup, SmartOp, SmartRule};
use crate::smart::PLAYLIST_FIELD;

/// デコード結果。`result` が Err ならそのプレイリストは変換しない (理由つき)。
#[derive(Debug)]
pub struct DecodeOutcome {
    pub result: Result<SmartCriteria, String>,
    pub warnings: Vec<String>,
}

/// SLst グループの先頭から最初のルールまでのオフセット。
const FIRST_RULE_OFFSET: usize = 136;
/// ルールヘッダ長 (データの直前まで)。
const RULE_HEADER_LEN: usize = 56;
/// 相対日付 (「過去 N 日以内」など) を表す値1 のマジック。
const RELATIVE_DATE_MAGIC: u64 = 0x2dae_2dae_2dae_2dae;
/// Mac (HFS+) 紀元 1904-01-01 から Unix 紀元までの秒数。
const MAC_EPOCH_OFFSET: i64 = 2_082_844_800;
/// このライブラリでは常に真とみなすメディアの種類 (ミュージック / ミュージックビデオ)。
const MUSIC_MEDIA_KINDS: [u64; 2] = [0x01, 0x20];
/// 入れ子の上限 (壊れたデータで無限再帰しないように)。
const MAX_DEPTH: usize = 16;

/// iTunes の Smart Criteria (+ 任意の Smart Info) を crateforge の条件に変換する。
pub fn decode_smart_playlist(criteria: &[u8], info: Option<&[u8]>) -> DecodeOutcome {
    let mut decoder = Decoder::default();
    let result = decoder.decode(criteria, info);
    DecodeOutcome {
        result,
        warnings: decoder.warnings,
    }
}

/// グループを畳み込んだ途中結果。
enum Folded {
    Rule(SmartRule),
    Group(SmartGroup),
    /// 常に真 / 常に偽 (メディアの種類など、このライブラリでは結果が決まっている条件)。
    Const(bool),
    /// 未対応で落とした条件 (親から取り除く)。
    Dropped,
}

#[derive(Default)]
struct Decoder {
    warnings: Vec<String>,
    dropped: usize,
}

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn u64_at(b: &[u8], off: usize) -> Option<u64> {
    b.get(off..off + 8).map(|s| {
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        u64::from_be_bytes(a)
    })
}

fn utf16be(data: &[u8]) -> Result<String, String> {
    if !data.len().is_multiple_of(2) {
        return Err("文字列データの長さが不正です".to_string());
    }
    let units: Vec<u16> = data
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&units).map_err(|_| "文字列データが UTF-16 として不正です".to_string())
}

/// 文字列フィールド (iTunes ID → crateforge のフィールド名)。
fn string_field(id: u32) -> Option<&'static str> {
    Some(match id {
        0x02 => "name",
        0x03 => "album",
        0x04 => "artist",
        0x08 => "genre",
        0x0e => "comments",
        0x12 => "composer",
        0x27 => "grouping",
        0x47 => "albumArtist",
        _ => return None,
    })
}

/// 数値フィールド。
fn int_field(id: u32) -> Option<&'static str> {
    Some(match id {
        0x05 => "bitrate",
        0x06 => "sampleRate",
        0x07 => "year",
        0x0b => "trackNumber",
        0x16 => "playCount",
        0x19 => "rating",
        0x23 => "bpm",
        0x44 => "skipCount",
        _ => return None,
    })
}

/// 日付フィールド (絶対日付のみ対応)。
fn date_field(id: u32) -> Option<&'static str> {
    Some(match id {
        0x10 => "dateAdded",
        0x17 => "lastPlayed",
        _ => return None,
    })
}

/// 対応していないが名前の分かるフィールド (警告文用)。
fn unsupported_field_label(id: u32) -> String {
    let name = match id {
        0x09 => "種類",
        0x0a => "変更日",
        0x0c => "サイズ",
        0x0d => "時間",
        0x18 => "ディスク番号",
        0x1d => "チェック",
        0x1f => "コンピレーション",
        0x45 => "最後にスキップした日",
        0x9a => "ラブ",
        _ => "",
    };
    if name.is_empty() {
        format!("フィールド 0x{id:02x}")
    } else {
        format!("「{name}」(0x{id:02x})")
    }
}

/// 数値の表示用文字列 (rating は 0-100 → 星 0-5 に換算済みの小数が来る)。
fn format_number(v: f64) -> String {
    format!("{v}")
}

fn rule(field: &str, op: SmartOp, value: String) -> SmartRule {
    SmartRule {
        field: field.to_string(),
        op,
        value,
    }
}

impl Decoder {
    fn decode(&mut self, criteria: &[u8], info: Option<&[u8]>) -> Result<SmartCriteria, String> {
        let folded = self.parse_group(criteria, 0)?;
        let mut out = match folded {
            Folded::Rule(r) => SmartCriteria {
                match_all: true,
                rules: vec![r],
                groups: Vec::new(),
                limit: None,
                sort_by: None,
                sort_desc: false,
                then_by: Vec::new(),
            },
            Folded::Group(g) => SmartCriteria {
                match_all: g.match_all,
                rules: g.rules,
                groups: g.groups,
                limit: None,
                sort_by: None,
                sort_desc: false,
                then_by: Vec::new(),
            },
            Folded::Const(true) if self.dropped == 0 => {
                // 元から実質無条件 (例: 「メディアの種類がミュージック」だけ)。全曲に一致させてよい。
                self.warnings
                    .push("条件が常に成り立つため全曲に一致します".to_string());
                SmartCriteria {
                    match_all: true,
                    rules: Vec::new(),
                    groups: Vec::new(),
                    limit: None,
                    sort_by: None,
                    sort_desc: false,
                    then_by: Vec::new(),
                }
            }
            Folded::Const(true) | Folded::Dropped => {
                return Err(
                    "変換できる条件が残らないため変換しません (全曲に一致してしまうため)"
                        .to_string(),
                )
            }
            Folded::Const(false) => {
                return Err("条件が常に成り立たない (一致する曲がない) ため変換しません".to_string())
            }
        };
        if let Some(info) = info {
            self.apply_info(info, &mut out);
        }
        Ok(out)
    }

    fn unsupported(&mut self, msg: String) -> Result<Folded, String> {
        self.dropped += 1;
        self.warnings.push(msg);
        Ok(Folded::Dropped)
    }

    fn parse_group(&mut self, b: &[u8], depth: usize) -> Result<Folded, String> {
        if depth > MAX_DEPTH {
            return Err("条件の入れ子が深すぎます".to_string());
        }
        if b.len() < 16 || &b[0..4] != b"SLst" {
            return Err("条件データの形式が不正です (SLst ヘッダがありません)".to_string());
        }
        if b[4..8] != [0x00, 0x01, 0x00, 0x01] {
            return Err(format!(
                "未知の条件データのバージョンです ({:02x}{:02x}{:02x}{:02x})",
                b[4], b[5], b[6], b[7]
            ));
        }
        let count = u32_at(b, 8).unwrap_or(0) as usize;
        let match_all = match u32_at(b, 12) {
            Some(0) => true,
            Some(1) => false,
            other => return Err(format!("未知の結合方法です ({other:?})")),
        };

        let mut children = Vec::with_capacity(count);
        let mut off = FIRST_RULE_OFFSET;
        for _ in 0..count {
            let header = b
                .get(off..off + RULE_HEADER_LEN)
                .ok_or_else(|| "条件データが途中で切れています".to_string())?;
            let field = u32_at(header, 0).unwrap_or(0);
            let sign = header[4];
            let logic = header[7];
            let len = u32_at(header, 52).unwrap_or(0) as usize;
            let data = b
                .get(off + RULE_HEADER_LEN..off + RULE_HEADER_LEN + len)
                .ok_or_else(|| "条件データが途中で切れています".to_string())?;
            children.push(self.parse_rule(field, sign, logic, data, depth)?);
            off += RULE_HEADER_LEN + len;
        }
        Ok(fold(match_all, children))
    }

    fn parse_rule(
        &mut self,
        field: u32,
        sign: u8,
        logic: u8,
        data: &[u8],
        depth: usize,
    ) -> Result<Folded, String> {
        let negated = sign & 0x02 != 0;
        let is_string = sign & 0x01 != 0;

        if field == 0 {
            if negated {
                return self
                    .unsupported("否定されたサブ条件は未対応のため除外しました".to_string());
            }
            return self.parse_group(data, depth + 1);
        }

        if let Some(name) = string_field(field) {
            if !is_string {
                return self.unsupported(format!("{name} の条件形式が不正なため除外しました"));
            }
            let value = utf16be(data)?;
            let op = match (logic, negated) {
                (0x01, false) => SmartOp::Is,
                (0x01, true) => SmartOp::IsNot,
                (0x02, false) => SmartOp::Contains,
                (0x02, true) => SmartOp::NotContains,
                (0x04, false) => SmartOp::StartsWith,
                (0x08, false) => SmartOp::EndsWith,
                _ => {
                    return self.unsupported(format!(
                        "{name} の演算 (0x{logic:02x}{}) は未対応のため除外しました",
                        if negated { ", 否定" } else { "" }
                    ))
                }
            };
            return Ok(Folded::Rule(rule(name, op, value)));
        }

        if field == 0x28 {
            // プレイリストに含まれる / 含まれない。
            let Some(pid) = u64_at(data, 0).filter(|_| logic == 0x01) else {
                return self
                    .unsupported("プレイリスト条件の形式が不正なため除外しました".to_string());
            };
            let op = if negated { SmartOp::IsNot } else { SmartOp::Is };
            return Ok(Folded::Rule(rule(
                PLAYLIST_FIELD,
                op,
                format!("{pid:016X}"),
            )));
        }

        if field == 0x3c {
            // メディアの種類。このライブラリは全曲ミュージック扱いなので結果は定数になる。
            let (Some(v1), Some(v2)) = (u64_at(data, 0), u64_at(data, 24)) else {
                return self
                    .unsupported("メディアの種類の条件形式が不正なため除外しました".to_string());
            };
            let (lo, hi) = match logic {
                0x01 => (v1, v1),
                0x00 => (v1.min(v2), v1.max(v2)),
                _ => {
                    return self.unsupported(format!(
                        "メディアの種類の演算 (0x{logic:02x}) は未対応のため除外しました"
                    ))
                }
            };
            let music = MUSIC_MEDIA_KINDS.iter().any(|k| lo <= *k && *k <= hi);
            return Ok(Folded::Const(music != negated));
        }

        if let Some(name) = int_field(field) {
            return self.int_rule(name, logic, negated, is_string, data);
        }

        if let Some(name) = date_field(field) {
            return self.date_rule(name, logic, negated, is_string, data);
        }

        self.unsupported(format!(
            "{} の条件は未対応のため除外しました",
            unsupported_field_label(field)
        ))
    }

    fn int_rule(
        &mut self,
        name: &str,
        logic: u8,
        negated: bool,
        is_string: bool,
        data: &[u8],
    ) -> Result<Folded, String> {
        let values = (!is_string)
            .then(|| {
                Some((
                    u64_at(data, 0)?,
                    u64_at(data, 16)?,
                    u64_at(data, 24)?,
                    u64_at(data, 40)?,
                ))
            })
            .flatten();
        let Some((v1, unit1, v2, unit2)) = values else {
            return self.unsupported(format!("{name} の条件形式が不正なため除外しました"));
        };
        // 単位は通常 1。0 は 1 とみなす。
        let scaled = |v: u64, unit: u64| (v as i64).saturating_mul(unit.max(1) as i64);
        // rating は iTunes では 0-100、crateforge の条件では星 (0-5) なので 20 で割る。
        let fmt = |v: i64| {
            if name == "rating" {
                format_number(v as f64 / 20.0)
            } else {
                v.to_string()
            }
        };
        let a = fmt(scaled(v1, unit1));
        let b = fmt(scaled(v2, unit2));
        match compare_rule(name, logic, negated, a, b) {
            Some(folded) => Ok(folded),
            None => self.unsupported(format!(
                "{name} の演算 (0x{logic:02x}{}) は未対応のため除外しました",
                if negated { ", 否定" } else { "" }
            )),
        }
    }

    fn date_rule(
        &mut self,
        name: &str,
        logic: u8,
        negated: bool,
        is_string: bool,
        data: &[u8],
    ) -> Result<Folded, String> {
        let values = (!is_string)
            .then(|| Some((u64_at(data, 0)?, u64_at(data, 24)?)))
            .flatten();
        let Some((v1, v2)) = values else {
            return self.unsupported(format!("{name} の条件形式が不正なため除外しました"));
        };
        if v1 == RELATIVE_DATE_MAGIC {
            return self.unsupported(format!(
                "{name} の相対日付 (「過去 N 日以内」など) は未対応のため除外しました"
            ));
        }
        // 絶対日付は Mac 紀元の秒 (iTunes のローカル時刻)。DB は UTC の ISO8601 文字列なので
        // タイムゾーン分のずれは許容し、同じ書式の文字列比較で判定する。
        let to_iso = |mac: u64| {
            chrono::DateTime::from_timestamp(mac as i64 - MAC_EPOCH_OFFSET, 0)
                .map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        };
        let (Some(a), Some(b)) = (to_iso(v1), to_iso(v2)) else {
            return self.unsupported(format!("{name} の日付が不正なため除外しました"));
        };
        if logic == 0x01 {
            return self.unsupported(format!("{name} の「日付が一致」は未対応のため除外しました"));
        }
        match compare_rule(name, logic, negated, a, b) {
            Some(folded) => Ok(folded),
            None => self.unsupported(format!(
                "{name} の演算 (0x{logic:02x}) は未対応のため除外しました"
            )),
        }
    }

    /// Smart Info の上限 (曲数) と、その上限を選ぶ並びを反映する。
    fn apply_info(&mut self, info: &[u8], out: &mut SmartCriteria) {
        if info.len() < 14 || info[2] == 0 {
            return; // 上限なし。
        }
        if info[3] != 3 {
            self.warnings
                .push("曲数以外の上限 (時間・容量) は未対応のため上限を外しました".to_string());
            return;
        }
        let limit = u32_at(info, 8).unwrap_or(0) as usize;
        let sort = u32_at(info, 4).unwrap_or(0);
        let reverse = info[13] != 0;
        // 実データで確認済み: 0x15 = 最近追加した順、0x19 = よく再生した順。
        // 0x1a / 0x1c は itunessmart の資料による (最近再生した順 / 評価の高い順)。
        let (field, desc) = match sort {
            0x15 => ("dateAdded", true),
            0x19 => ("playCount", true),
            0x1a => ("lastPlayed", true),
            0x1c => ("rating", true),
            _ => {
                self.warnings.push(format!(
                    "上限の選び方 (0x{sort:02x}、ランダムなど) は未対応のため上限を外しました"
                ));
                return;
            }
        };
        out.limit = Some(limit);
        out.sort_by = Some(field.to_string());
        out.sort_desc = desc != reverse;
    }
}

/// 比較演算 (一致・より大・より小・範囲) を条件に組み立てる。未対応の組み合わせは None。
fn compare_rule(name: &str, logic: u8, negated: bool, a: String, b: String) -> Option<Folded> {
    let single = |op| Some(Folded::Rule(rule(name, op, a.clone())));
    match (logic, negated) {
        (0x01, false) => single(SmartOp::Is),
        (0x01, true) => single(SmartOp::IsNot),
        (0x10, false) => single(SmartOp::Gt),
        (0x10, true) => single(SmartOp::Lte),
        (0x40, false) => single(SmartOp::Lt),
        (0x40, true) => single(SmartOp::Gte),
        // 範囲: a 以上 b 以下 (否定なら a 未満または b 超)。
        (0x00, false) => Some(Folded::Group(SmartGroup {
            match_all: true,
            rules: vec![rule(name, SmartOp::Gte, a), rule(name, SmartOp::Lte, b)],
            groups: Vec::new(),
        })),
        (0x00, true) => Some(Folded::Group(SmartGroup {
            match_all: false,
            rules: vec![rule(name, SmartOp::Lt, a), rule(name, SmartOp::Gt, b)],
            groups: Vec::new(),
        })),
        _ => None,
    }
}

/// 子を結合方法で畳み込む。定数は短絡・除去し、子が 1 つなら引き上げ、同じ結合方法の
/// 子グループは親に平坦化する。
fn fold(match_all: bool, children: Vec<Folded>) -> Folded {
    let mut nodes = Vec::new();
    let mut had_dropped = false;
    for child in children {
        match child {
            // ALL に偽 / ANY に真があれば全体が決まる。もう一方の定数は影響しないので除く。
            Folded::Const(v) if v != match_all => return Folded::Const(v),
            Folded::Const(_) => {}
            Folded::Dropped => had_dropped = true,
            node => nodes.push(node),
        }
    }
    if nodes.is_empty() {
        return if had_dropped {
            Folded::Dropped
        } else {
            Folded::Const(match_all)
        };
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
            Folded::Rule(r) => group.rules.push(r),
            Folded::Group(child) if child.match_all == match_all => {
                group.rules.extend(child.rules);
                group.groups.extend(child.groups);
            }
            Folded::Group(child) => group.groups.push(child),
            Folded::Const(_) | Folded::Dropped => {}
        }
    }
    Folded::Group(group)
}

/// XML の `<data>` (改行・タブ入りの base64) をバイト列に戻す。
pub fn decode_plist_data(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let compact: String = text.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .ok()
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! 実ライブラリ (iTunes for Windows 12.x) から抜き出した Smart Criteria / Smart Info。
    //! 参照先 PID: C8EA7D9C323131DF = Favorite SONGS (現行)、3C0E5A28D090134F = Favorite SONGS
    //! (2022 年の旧ライブラリ)、B873A90DB6BAA17B = 台湾音楽 (旧ライブラリ)。
    /// 「Favorite J-POP」 (D6DDCCBCC745E045) の Smart Criteria。
    pub(crate) const JPOP_CRITERIA: &str = concat!(
        "U0xzdAABAAEAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAU0xzdAAB",
        "AAEAAAACAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "ADwAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEAAAAAAAAAAEAAAAA",
        "AAAAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAQAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARAAAAAAAAAAgAAAAAAAAAAAAAAAA",
        "AAAAAQAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkxTTHN0AAEAAQAAAAIAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARBTTHN0AAEAAQAAAAIAAAABAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAEAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoASgAtAFAATwBQAAAACAEAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4ASgAtAEkAbgBkAGkAZQAAACgAAAABAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEyOp9nDIxMd8AAAAAAAAAAAAAAAAAAAAByOp9nDIxMd8AAAAA",
        "AAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    pub(crate) const JPOP_INFO: &str = concat!(
        "AQEAAwAAAAIAAAAZAAAAAAAAAAcAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    );
    /// 「Favorite SONGS」 (C8EA7D9C323131DF) の Smart Criteria。
    pub(crate) const SONGS_CRITERIA: &str = concat!(
        "U0xzdAABAAEAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAU0xzdAAB",
        "AAEAAAACAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "ADwAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEAAAAAAAAAAEAAAAA",
        "AAAAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAQAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARAAAAAAAAAAgAAAAAAAAAAAAAAAA",
        "AAAAAQAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVBTTHN0AAEAAQAAAAIAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAABAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEQAAAAAAAAAMQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAMQAA",
        "AAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgDAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAFMAbwB1AG4AZAB0AHIAYQBjAGs=",
    );
    pub(crate) const SONGS_INFO: &str = concat!(
        "AQEAAwAAAAIAAAAZAAAAAAAAAAcAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    );
    /// 「Favorite アイドル」 (DD832CD875A4F4D8) の Smart Criteria。
    pub(crate) const IDOL_CRITERIA: &str = concat!(
        "U0xzdAABAAEAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAU0xzdAAB",
        "AAEAAAACAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "ADwAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEAAAAAAAAAAEAAAAA",
        "AAAAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAQAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARAAAAAAAAAAgAAAAAAAAAAAAAAAA",
        "AAAAAQAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAchTTHN0AAEAAQAAAAQAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJwEAAAIAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgASQBkAG8AbAAAABkAAAAQAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEAAAAAAAAADEAAAAAAAAAAAAAAAAAAAABAAAAAAAAADEAAAAA",
        "AAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAwAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAACgBBAG4AaQBtAGUAAAAIAwAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAACgBSAGUAbQBpAHg=",
    );
    pub(crate) const IDOL_INFO: &str = concat!(
        "AQEAAwAAAAIAAAAZAAAAAAAAAAcAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    );
    /// 「Favorite 台湾音楽」 (C7D0A19E9FD296B2) の Smart Criteria。
    pub(crate) const TAIWAN_CRITERIA: &str = concat!(
        "U0xzdAABAAEAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAU0xzdAAB",
        "AAEAAAACAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "ADwAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEAAAAAAAAAAEAAAAA",
        "AAAAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAQAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARAAAAAAAAAAgAAAAAAAAAAAAAAAA",
        "AAAAAQAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBTTHN0AAEAAQAAAAIAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAAEAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEQ8Dloo0JATTwAAAAAAAAAAAAAAAAAAAAE8Dloo0JATTwAA",
        "AAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEuHOpDba6oXsAAAAAAAAAAAAAAAAAAAABuHOpDba6oXsAAAAAAAAAAAAA",
        "AAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    pub(crate) const TAIWAN_INFO: &str = concat!(
        "AQEAAwAAAAIAAAAZAAAAAAAAAAcAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    );
    /// 「トップ 150」 (217E6755D42F9EC9) の Smart Criteria。
    pub(crate) const TOP150_CRITERIA: &str = concat!(
        "U0xzdAABAAEAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAADwCAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEAAAAAAAA",
        "AAQAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAW",
        "AAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAMAAAIAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAUwBvAHUAbgBkAHQAcgBhAGMAaw==",
    );
    pub(crate) const TOP150_INFO: &str = concat!(
        "AQEBAwAAABkAAACWAQAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    );
    pub(crate) fn bytes(b64: &str) -> Vec<u8> {
        super::decode_plist_data(b64).expect("valid base64 fixture")
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn decode_fixture(criteria: &str, info: &str) -> (SmartCriteria, Vec<String>) {
        let out = decode_smart_playlist(&bytes(criteria), Some(&bytes(info)));
        (out.result.expect("decodes"), out.warnings)
    }

    fn r(field: &str, op: SmartOp, value: &str) -> SmartRule {
        rule(field, op, value.to_string())
    }

    /// Favorite J-POP: ALL[ ANY[genre contains J-POP, genre contains J-Indie],
    /// playlist is Favorite SONGS ]。メディアの種類のグループは消える。
    #[test]
    fn favorite_jpop() {
        let (c, warnings) = decode_fixture(JPOP_CRITERIA, JPOP_INFO);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![r("playlist", SmartOp::Is, "C8EA7D9C323131DF")]
        );
        assert_eq!(
            c.groups,
            vec![SmartGroup {
                match_all: false,
                rules: vec![
                    r("genre", SmartOp::Contains, "J-POP"),
                    r("genre", SmartOp::Contains, "J-Indie"),
                ],
                groups: vec![],
            }]
        );
        assert_eq!(c.limit, None);
        assert_eq!(c.sort_by, None);
    }

    /// Favorite SONGS: ALL[rating > 49 (= 2.45 星), genre notContains Soundtrack]。
    #[test]
    fn favorite_songs() {
        let (c, warnings) = decode_fixture(SONGS_CRITERIA, SONGS_INFO);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("rating", SmartOp::Gt, "2.45"),
                r("genre", SmartOp::NotContains, "Soundtrack"),
            ]
        );
        assert!(c.groups.is_empty());
    }

    /// Favorite アイドル: grouping contains Idol + rating + genre の除外 2 つ。
    #[test]
    fn favorite_idol() {
        let (c, warnings) = decode_fixture(IDOL_CRITERIA, IDOL_INFO);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("grouping", SmartOp::Contains, "Idol"),
                r("rating", SmartOp::Gt, "2.45"),
                r("genre", SmartOp::NotContains, "Anime"),
                r("genre", SmartOp::NotContains, "Remix"),
            ]
        );
        assert!(c.groups.is_empty());
    }

    /// Favorite 台湾音楽: 旧ライブラリの PID を指すプレイリスト参照が 2 つ。
    #[test]
    fn favorite_taiwan() {
        let (c, warnings) = decode_fixture(TAIWAN_CRITERIA, TAIWAN_INFO);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("playlist", SmartOp::Is, "3C0E5A28D090134F"),
                r("playlist", SmartOp::Is, "B873A90DB6BAA17B"),
            ]
        );
        assert!(c.groups.is_empty());
    }

    /// トップ 150: 「メディアの種類が Podcast でない」は常に真で消え、上限 150 曲 (よく再生した順)。
    #[test]
    fn top150_limit_and_sort() {
        let (c, warnings) = decode_fixture(TOP150_CRITERIA, TOP150_INFO);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(c.match_all);
        assert_eq!(
            c.rules,
            vec![
                r("playCount", SmartOp::Gt, "0"),
                r("genre", SmartOp::NotContains, "Soundtrack"),
            ]
        );
        assert_eq!(c.limit, Some(150));
        assert_eq!(c.sort_by.as_deref(), Some("playCount"));
        assert!(c.sort_desc);
    }

    // ---- 合成データ ----

    /// SLst グループを組み立てる。
    fn slst(any: bool, rules: &[Vec<u8>]) -> Vec<u8> {
        let mut b = b"SLst".to_vec();
        b.extend_from_slice(&[0, 1, 0, 1]);
        b.extend_from_slice(&(rules.len() as u32).to_be_bytes());
        b.extend_from_slice(&(any as u32).to_be_bytes());
        b.resize(FIRST_RULE_OFFSET, 0);
        for r in rules {
            b.extend_from_slice(r);
        }
        b
    }

    fn raw_rule(field: u32, sign: u8, logic: u8, data: &[u8]) -> Vec<u8> {
        let mut h = vec![0u8; RULE_HEADER_LEN];
        h[0..4].copy_from_slice(&field.to_be_bytes());
        h[4] = sign;
        h[7] = logic;
        h[52..56].copy_from_slice(&(data.len() as u32).to_be_bytes());
        h.extend_from_slice(data);
        h
    }

    fn int_data(v1: u64, v2: u64) -> Vec<u8> {
        let mut d = vec![0u8; 0x44];
        d[0..8].copy_from_slice(&v1.to_be_bytes());
        d[16..24].copy_from_slice(&1u64.to_be_bytes());
        d[24..32].copy_from_slice(&v2.to_be_bytes());
        d[40..48].copy_from_slice(&1u64.to_be_bytes());
        d
    }

    fn str_data(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
    }

    fn media_music_group() -> Vec<u8> {
        slst(
            true,
            &[
                raw_rule(0x3c, 0, 0x01, &int_data(1, 1)),
                raw_rule(0x3c, 0, 0x01, &int_data(0x20, 0x20)),
            ],
        )
    }

    /// 数値の範囲は ALL[gte, lte]、否定は ANY[lt, gt] になる。
    #[test]
    fn int_range_becomes_group() {
        let blob = slst(
            true,
            &[
                raw_rule(0x23, 0, 0x00, &int_data(120, 130)),
                raw_rule(0x07, 2, 0x00, &int_data(1990, 1999)),
            ],
        );
        let c = decode_smart_playlist(&blob, None).result.unwrap();
        assert!(!c.match_all);
        // 否定の範囲 (ANY) は親の ANY に平坦化される。
        assert_eq!(
            c.rules,
            vec![
                r("year", SmartOp::Lt, "1990"),
                r("year", SmartOp::Gt, "1999")
            ]
        );
        assert_eq!(
            c.groups,
            vec![SmartGroup {
                match_all: true,
                rules: vec![r("bpm", SmartOp::Gte, "120"), r("bpm", SmartOp::Lte, "130")],
                groups: vec![],
            }]
        );
    }

    /// 未対応の条件は警告付きで落とす。残りがあれば変換する。
    #[test]
    fn unsupported_rule_is_dropped_with_warning() {
        let blob = slst(
            true,
            &[
                raw_rule(0, 0, 0x01, &media_music_group()),
                raw_rule(0x9a, 0, 0x01, &int_data(2, 2)),
                raw_rule(0x02, 1, 0x04, &str_data("Intro")),
                raw_rule(0x04, 1, 0x08, &str_data("Punk")),
            ],
        );
        // ANY の中にメディアの種類 (常に真) があるので、全体が常に真 → 変換しない。
        let out = decode_smart_playlist(&blob, None);
        assert!(out.result.is_err());

        let blob = slst(
            true,
            &[
                raw_rule(0x9a, 0, 0x01, &int_data(2, 2)),
                raw_rule(0x02, 1, 0x04, &str_data("Intro")),
                raw_rule(0x04, 1, 0x08, &str_data("Punk")),
            ],
        );
        let out = decode_smart_playlist(&blob, None);
        let c = out.result.unwrap();
        assert!(!c.match_all);
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        assert!(out.warnings[0].contains("ラブ"));
        assert_eq!(
            c.rules,
            vec![
                r("name", SmartOp::StartsWith, "Intro"),
                r("artist", SmartOp::EndsWith, "Punk"),
            ]
        );
    }

    /// 落とした結果ルールが残らないなら失敗 (全曲に一致させない)。
    #[test]
    fn fails_when_nothing_effective_remains() {
        // ALL[ ANY[メディアの種類 = ミュージック], ALL[チェック (未対応)] ]。
        let blob = slst(
            false,
            &[
                raw_rule(0, 0, 0x01, &media_music_group()),
                raw_rule(
                    0,
                    0,
                    0x01,
                    &slst(false, &[raw_rule(0x1d, 0, 0x01, &int_data(1, 1))]),
                ),
            ],
        );
        let out = decode_smart_playlist(&blob, None);
        assert!(out.result.is_err(), "{:?}", out.result);
        assert!(!out.warnings.is_empty());

        // 相対日付だけの条件も同様。
        let mut rel = int_data(RELATIVE_DATE_MAGIC, RELATIVE_DATE_MAGIC);
        rel[8..16].copy_from_slice(&(-7i64).to_be_bytes());
        let blob = slst(false, &[raw_rule(0x10, 0, 0x00, &rel)]);
        assert!(decode_smart_playlist(&blob, None).result.is_err());
    }

    /// 絶対日付は ISO8601 文字列に変換して比較する。
    #[test]
    fn absolute_date() {
        // 3566159999 (Mac 紀元) = 2017-01-01T23:59:59 (実データの「追加日が 2017/01/01 より後」)。
        let blob = slst(
            false,
            &[raw_rule(
                0x10,
                0,
                0x10,
                &int_data(3_566_159_999, 3_566_159_999),
            )],
        );
        let c = decode_smart_playlist(&blob, None).result.unwrap();
        assert_eq!(
            c.rules,
            vec![r("dateAdded", SmartOp::Gt, "2017-01-01T23:59:59Z")]
        );
    }

    /// 曲数以外の上限やランダム選択は警告付きで外す。
    #[test]
    fn unsupported_limits_are_dropped() {
        let blob = slst(false, &[raw_rule(0x08, 1, 0x02, &str_data("House"))]);
        let mut info = vec![0u8; 112];
        info[0] = 1;
        info[2] = 1;
        info[3] = 1; // 分
        info[8..12].copy_from_slice(&65u32.to_be_bytes());
        let out = decode_smart_playlist(&blob, Some(&info));
        assert_eq!(out.result.unwrap().limit, None);
        assert_eq!(out.warnings.len(), 1);

        info[3] = 3;
        info[4..8].copy_from_slice(&2u32.to_be_bytes()); // ランダム
        let out = decode_smart_playlist(&blob, Some(&info));
        assert_eq!(out.result.unwrap().limit, None);
        assert_eq!(out.warnings.len(), 1);

        info[4..8].copy_from_slice(&0x15u32.to_be_bytes());
        info[13] = 1; // 逆順 = 古く追加した順
        let out = decode_smart_playlist(&blob, Some(&info));
        let c = out.result.unwrap();
        assert_eq!(c.limit, Some(65));
        assert_eq!(c.sort_by.as_deref(), Some("dateAdded"));
        assert!(!c.sort_desc);
    }

    /// 壊れたデータはエラー (パニックしない)。
    #[test]
    fn malformed_data_is_an_error() {
        assert!(decode_smart_playlist(b"nope", None).result.is_err());
        let mut blob = slst(false, &[raw_rule(0x08, 1, 0x02, &str_data("House"))]);
        blob.truncate(blob.len() - 3);
        assert!(decode_smart_playlist(&blob, None).result.is_err());
    }
}
