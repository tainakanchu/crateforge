//! 「すでにライブラリにある曲」の検出 (iTunes の「取り込み済み」相当)。
//!
//! CD リッピング / ファイル取り込みの前に、取り込もうとしている曲と同じ曲が
//! ライブラリにあるかを曲名・アーティスト・アルバム・長さで照合する。
//! 照合自体は DB / tauri に依存しない純粋な処理で、ライブラリ全体 (数万曲) を
//! 1 リクエストにつき 1 回だけ読み込んで正規化済みの索引 ([`MatchIndex`]) を作り、
//! 各クエリはハッシュ引きで候補を絞る (曲ごとの全件走査はしない)。
//!
//! - [`health`]: 一致した既存曲のファイル状態 (なし / 破損の疑い) の判定。
//! - [`replace`]: 既存曲を新しいファイルへ置き換える共通処理 (リップ / 取り込み共用)。

pub mod health;
pub mod replace;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::DuplicateHit;
use crate::text_fold::{fold, FoldLevel};

/// 既存曲の長さがこれ未満なら壊れた値 (0 秒など) とみなし、長さでの照合に使わない。
const MIN_TRUSTED_DURATION_MS: i64 = 10_000;
/// 長さの許容差。CD とファイルでギャップの扱いが違う程度の差は同じ曲とみなす。
const DURATION_TOLERANCE_MS: i64 = 3_000;
/// 1 クエリあたりに返す最大件数。
const MAX_HITS: usize = 3;

/// 照合の確からしさ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    /// 曲名 + アーティスト + アルバム一致、長さも許容差内。
    Exact,
    /// 曲名 + アーティスト一致、長さも許容差内 (アルバムが違う / 不明)。
    Probable,
    /// 長さで確かめられない (どちらかの長さが不明・壊れている)、
    /// または曲名の括弧書きを外して初めて一致した、
    /// または双方ともアーティスト不明 (タグ無し) で曲名 + 長さだけが一致した。
    Weak,
}

/// 照合したい曲 (CD のトラック / 取り込もうとしているファイル)。
#[derive(Debug, Clone, Default)]
pub struct MatchQuery<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub album_artist: Option<&'a str>,
    pub album: Option<&'a str>,
    #[allow(dead_code)]
    pub track_number: Option<i64>,
    pub duration_ms: Option<i64>,
}

/// 照合に使う既存曲の列 (DB から 1 回だけまとめて読む)。
#[derive(Debug, Clone, Default)]
pub struct LibraryRow {
    pub track_id: i64,
    pub name: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub total_time_ms: Option<i64>,
    pub location_path: Option<String>,
    pub file_exists: bool,
}

/// 1 件の一致。`row` は [`MatchIndex::row`] で引く。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchHit {
    pub row_index: usize,
    pub track_id: i64,
    pub kind: MatchKind,
    /// 長さの差の絶対値 (長さで照合できたときだけ)。
    pub duration_delta_ms: Option<i64>,
}

/// 照合用キーへの正規化: 字体ゆれ吸収 (標準) のあと、文字と数字以外 (記号・空白) を落とす。
pub fn normalize(s: &str) -> String {
    fold(s, FoldLevel::Standard)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// 末尾の括弧書き ("(Remastered)" / "[Live]" / "【TV size】" など) を繰り返し外す。
/// 括弧しか無い曲名は空にせず元のまま返す。
pub fn strip_trailing_brackets(s: &str) -> String {
    const PAIRS: &[(char, char)] = &[
        ('(', ')'),
        ('[', ']'),
        ('{', '}'),
        ('（', '）'),
        ('［', '］'),
        ('【', '】'),
        ('〔', '〕'),
        ('「', '」'),
        ('『', '』'),
        ('<', '>'),
        ('〈', '〉'),
        ('《', '》'),
    ];
    let mut cur = s.trim().to_string();
    loop {
        let Some(last) = cur.chars().last() else {
            break;
        };
        let Some(&(open, _)) = PAIRS.iter().find(|(_, c)| *c == last) else {
            break;
        };
        let Some(pos) = cur.rfind(open) else { break };
        let head = cur[..pos].trim_end();
        if head.is_empty() {
            break;
        }
        cur = head
            .trim_end_matches(['-', '‐', '–', '—', '~', '～'])
            .trim_end()
            .to_string();
    }
    if cur.is_empty() {
        s.trim().to_string()
    } else {
        cur
    }
}

struct IndexedRow {
    artist: String,
    album_artist: String,
    album: String,
}

/// ライブラリ全体の照合用索引。正規化はここで 1 回だけ行う。
pub struct MatchIndex {
    rows: Vec<LibraryRow>,
    keys: Vec<IndexedRow>,
    by_title: HashMap<String, Vec<usize>>,
    by_base_title: HashMap<String, Vec<usize>>,
}

impl MatchIndex {
    pub fn new(rows: Vec<LibraryRow>) -> Self {
        let mut by_title: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_base_title: HashMap<String, Vec<usize>> = HashMap::new();
        let mut keys = Vec::with_capacity(rows.len());
        for (i, r) in rows.iter().enumerate() {
            let name = r.name.as_deref().unwrap_or("");
            let t = normalize(name);
            if !t.is_empty() {
                let b = normalize(&strip_trailing_brackets(name));
                by_title.entry(t).or_default().push(i);
                if !b.is_empty() {
                    by_base_title.entry(b).or_default().push(i);
                }
            }
            keys.push(IndexedRow {
                artist: normalize(r.artist.as_deref().unwrap_or("")),
                album_artist: normalize(r.album_artist.as_deref().unwrap_or("")),
                album: normalize(r.album.as_deref().unwrap_or("")),
            });
        }
        MatchIndex {
            rows,
            keys,
            by_title,
            by_base_title,
        }
    }

    pub fn row(&self, index: usize) -> &LibraryRow {
        &self.rows[index]
    }

    /// クエリに一致する既存曲を確からしい順に最大 [`MAX_HITS`] 件返す。
    pub fn find(&self, q: &MatchQuery) -> Vec<MatchHit> {
        let title = normalize(q.title);
        if title.is_empty() {
            return Vec::new();
        }
        let base = normalize(&strip_trailing_brackets(q.title));
        let artist = normalize(q.artist);
        let album_artist = q.album_artist.map(normalize).unwrap_or_default();
        let album = q.album.map(normalize).unwrap_or_default();

        // (行, 括弧外しで初めて一致したか)
        let mut cands: Vec<(usize, bool)> = Vec::new();
        if let Some(v) = self.by_title.get(&title) {
            cands.extend(v.iter().map(|&i| (i, false)));
        }
        if !base.is_empty() {
            if let Some(v) = self.by_base_title.get(&base) {
                for &i in v {
                    if !cands.iter().any(|(j, _)| *j == i) {
                        cands.push((i, true));
                    }
                }
            }
        }

        // クエリ側のアーティストが不明 (タグ無し)。空同士の一致はアーティスト一致とみなさない。
        let query_artist_unknown = artist.is_empty() && album_artist.is_empty();

        let mut hits: Vec<MatchHit> = Vec::new();
        for (i, weak_title) in cands {
            let k = &self.keys[i];
            let artist_ok = (!artist.is_empty()
                && (artist == k.artist || artist == k.album_artist))
                || (!k.album_artist.is_empty()
                    && (k.album_artist == album_artist || k.album_artist == artist));
            // 双方ともアーティスト不明 (タグの無いファイル同士)。曲名がファイル名由来の
            // "Track 01" 等になりがちなので、曲名 + 長さが合うときだけ候補にし、
            // 確からしさは常に Weak (既定は取り込む・「要確認」表示) に留める。
            let both_artist_unknown =
                query_artist_unknown && k.artist.is_empty() && k.album_artist.is_empty();
            if !artist_ok && !both_artist_unknown {
                continue;
            }
            let row = &self.rows[i];
            let row_dur = row.total_time_ms.filter(|&d| d >= MIN_TRUSTED_DURATION_MS);
            let (duration_checked, delta) = match (q.duration_ms.filter(|&d| d > 0), row_dur) {
                (Some(a), Some(b)) => {
                    let d = (a - b).abs();
                    if d > DURATION_TOLERANCE_MS {
                        continue;
                    }
                    (true, Some(d))
                }
                _ => (false, None),
            };
            if both_artist_unknown && !duration_checked {
                continue;
            }
            // アルバムも空同士は一致とみなさない (album が空なら album_ok は常に false)。
            let album_ok = !album.is_empty() && album == k.album;
            let kind = if both_artist_unknown || weak_title || !duration_checked {
                MatchKind::Weak
            } else if album_ok {
                MatchKind::Exact
            } else {
                MatchKind::Probable
            };
            hits.push(MatchHit {
                row_index: i,
                track_id: row.track_id,
                kind,
                duration_delta_ms: delta,
            });
        }
        hits.sort_by(|a, b| {
            a.kind
                .cmp(&b.kind)
                .then_with(|| {
                    // ファイルのある曲を先に (置き換え先としても表示としても自然)。
                    let ea = self.rows[a.row_index].file_exists;
                    let eb = self.rows[b.row_index].file_exists;
                    eb.cmp(&ea)
                })
                .then_with(|| {
                    a.duration_delta_ms
                        .unwrap_or(i64::MAX)
                        .cmp(&b.duration_delta_ms.unwrap_or(i64::MAX))
                })
                .then_with(|| a.track_id.cmp(&b.track_id))
        });
        hits.truncate(MAX_HITS);
        hits
    }
}

/// 一致を UI 向けの [`DuplicateHit`] にする。ファイル状態の判定 (I/O) は
/// 一致した曲だけに行い、同じ曲は `health_cache` で 1 回に抑える。
pub fn to_duplicate_hits(
    index: &MatchIndex,
    hits: &[MatchHit],
    health_cache: &mut HashMap<i64, health::FileHealth>,
) -> Vec<DuplicateHit> {
    hits.iter()
        .map(|h| {
            let r = index.row(h.row_index);
            let health = *health_cache
                .entry(r.track_id)
                .or_insert_with(|| health::probe(r.location_path.as_deref(), r.file_exists));
            DuplicateHit {
                track_id: r.track_id,
                name: r.name.clone(),
                artist: r.artist.clone(),
                album: r.album.clone(),
                total_time_ms: r.total_time_ms,
                location_path: r.location_path.clone(),
                health,
                kind: h.kind,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, name: &str, artist: &str, album: &str, ms: Option<i64>) -> LibraryRow {
        LibraryRow {
            track_id: id,
            name: Some(name.to_string()),
            artist: Some(artist.to_string()),
            album_artist: None,
            album: Some(album.to_string()),
            total_time_ms: ms,
            location_path: Some(format!("/m/{id}.mp3")),
            file_exists: true,
        }
    }

    fn q<'a>(
        title: &'a str,
        artist: &'a str,
        album: Option<&'a str>,
        ms: Option<i64>,
    ) -> MatchQuery<'a> {
        MatchQuery {
            title,
            artist,
            album,
            duration_ms: ms,
            ..Default::default()
        }
    }

    #[test]
    fn normalize_absorbs_width_kana_case_and_punctuation() {
        assert_eq!(normalize("ＡＢＣ　ｄｅｆ!"), normalize("abc def"));
        assert_eq!(normalize("カタカナ"), normalize("かたかな"));
        assert_eq!(normalize("Don't Stop - Me"), normalize("dont stop me"));
        assert_eq!(normalize("ﾊﾝｶｸ"), normalize("ハンカク"));
    }

    #[test]
    fn strip_trailing_brackets_removes_suffixes_only() {
        assert_eq!(strip_trailing_brackets("Song (Remastered 2011)"), "Song");
        assert_eq!(strip_trailing_brackets("Song [Live] (Edit)"), "Song");
        assert_eq!(strip_trailing_brackets("曲名【TV size】"), "曲名");
        assert_eq!(strip_trailing_brackets("(Intro)"), "(Intro)");
        assert_eq!(strip_trailing_brackets("A (B) C"), "A (B) C");
    }

    #[test]
    fn exact_match_with_fold_variants() {
        let idx = MatchIndex::new(vec![row(
            1,
            "残酷な天使のテーゼ",
            "高橋洋子",
            "Neon Genesis",
            Some(245_000),
        )]);
        let hits = idx.find(&q(
            "残酷な天使のテーゼ",
            "高橋 洋子",
            Some("NEON GENESIS"),
            Some(246_500),
        ));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, MatchKind::Exact);
        assert_eq!(hits[0].duration_delta_ms, Some(1_500));

        // 全角・カタカナ/ひらがなのゆれ
        let idx = MatchIndex::new(vec![row(2, "ｶﾀｶﾅ Song!", "ARTIST", "Album", Some(200_000))]);
        let hits = idx.find(&q("かたかな song", "artist", Some("album"), Some(200_000)));
        assert_eq!(hits[0].kind, MatchKind::Exact);
    }

    #[test]
    fn duration_tolerance_rejects_far_lengths() {
        let idx = MatchIndex::new(vec![row(1, "Song", "Artist", "Album", Some(200_000))]);
        assert_eq!(
            idx.find(&q("Song", "Artist", Some("Album"), Some(203_000)))
                .len(),
            1
        );
        assert!(idx
            .find(&q("Song", "Artist", Some("Album"), Some(203_001)))
            .is_empty());
        assert!(idx
            .find(&q("Song", "Artist", Some("Album"), Some(150_000)))
            .is_empty());
    }

    #[test]
    fn corrupted_or_missing_duration_downgrades_to_weak() {
        let idx = MatchIndex::new(vec![
            row(1, "Song", "Artist", "Album", Some(0)),
            row(2, "Other", "Artist", "Album", None),
        ]);
        let h = idx.find(&q("Song", "Artist", Some("Album"), Some(200_000)));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kind, MatchKind::Weak);
        let h = idx.find(&q("Other", "Artist", Some("Album"), Some(200_000)));
        assert_eq!(h[0].kind, MatchKind::Weak);
        // クエリ側の長さ不明も Weak
        let h = idx.find(&q("Song", "Artist", Some("Album"), None));
        assert_eq!(h[0].kind, MatchKind::Weak);
    }

    #[test]
    fn album_differs_is_probable() {
        let idx = MatchIndex::new(vec![row(1, "Song", "Artist", "Best Of", Some(200_000))]);
        let h = idx.find(&q("Song", "Artist", Some("Original Album"), Some(201_000)));
        assert_eq!(h[0].kind, MatchKind::Probable);
        let h = idx.find(&q("Song", "Artist", None, Some(201_000)));
        assert_eq!(h[0].kind, MatchKind::Probable);
    }

    #[test]
    fn artist_must_match_artist_or_album_artist() {
        let mut r = row(1, "Song", "Feat Guy", "Album", Some(200_000));
        r.album_artist = Some("Main Artist".into());
        let idx = MatchIndex::new(vec![r]);
        assert!(idx
            .find(&q("Song", "Someone Else", Some("Album"), Some(200_000)))
            .is_empty());
        assert_eq!(
            idx.find(&q("Song", "Main Artist", Some("Album"), Some(200_000)))
                .len(),
            1
        );
        let qq = MatchQuery {
            title: "Song",
            artist: "Different",
            album_artist: Some("main artist"),
            album: Some("Album"),
            duration_ms: Some(200_000),
            ..Default::default()
        };
        assert_eq!(idx.find(&qq)[0].kind, MatchKind::Exact);
    }

    #[test]
    fn bracket_stripped_title_is_weak_only() {
        let idx = MatchIndex::new(vec![row(
            1,
            "Song (Remastered)",
            "Artist",
            "Album",
            Some(200_000),
        )]);
        let h = idx.find(&q("Song", "Artist", Some("Album"), Some(200_000)));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kind, MatchKind::Weak);
    }

    #[test]
    fn hits_sorted_by_confidence_and_capped() {
        let idx = MatchIndex::new(vec![
            row(1, "Song", "Artist", "Other", Some(200_000)),
            row(2, "Song", "Artist", "Album", Some(201_000)),
            row(3, "Song", "Artist", "Album", Some(0)),
            row(4, "Song", "Artist", "Album", Some(200_500)),
            row(5, "Song", "Artist", "X", Some(200_000)),
        ]);
        let h = idx.find(&q("Song", "Artist", Some("Album"), Some(200_000)));
        assert_eq!(h.len(), MAX_HITS);
        assert_eq!(h[0].track_id, 4);
        assert_eq!(h[0].kind, MatchKind::Exact);
        assert_eq!(h[1].track_id, 2);
        assert_eq!(h[2].kind, MatchKind::Probable);
    }

    #[test]
    fn empty_title_never_matches() {
        let idx = MatchIndex::new(vec![row(1, "", "Artist", "Album", Some(200_000))]);
        assert!(idx.find(&q("", "Artist", None, None)).is_empty());
        assert!(idx.find(&q("!!", "Artist", None, None)).is_empty());
    }

    fn untagged(id: i64, name: &str, ms: Option<i64>) -> LibraryRow {
        LibraryRow {
            track_id: id,
            name: Some(name.to_string()),
            artist: None,
            album_artist: None,
            album: None,
            total_time_ms: ms,
            location_path: Some(format!("/m/{id}.mp3")),
            file_exists: true,
        }
    }

    /// タグの無いファイル同士: 空のアーティスト / アルバムを「一致」とみなさない。
    /// 曲名 + 長さが合うときだけ Weak (要確認・既定は取り込む) で出し、長さが違う /
    /// 確かめられないときは出さない。
    #[test]
    fn untagged_files_need_title_and_length_and_stay_weak() {
        let idx = MatchIndex::new(vec![
            untagged(1, "Track 01", Some(200_000)),
            untagged(2, "Track 01", Some(320_000)),
            untagged(3, "Track 01", None),
        ]);
        // 長さが合う 1 だけ。Exact / Probable にはならない。
        let h = idx.find(&q("Track 01", "", None, Some(201_000)));
        assert_eq!(h.len(), 1, "{h:?}");
        assert_eq!(h[0].track_id, 1);
        assert_eq!(h[0].kind, MatchKind::Weak);
        // 長さが不明なクエリは、空のアーティストだけでは何も一致させない。
        assert!(idx.find(&q("Track 01", "", None, None)).is_empty());
        // 長さがどれとも合わない。
        assert!(idx.find(&q("Track 01", "", None, Some(100_000))).is_empty());
        // 空アルバム同士でも Exact にしない (album_ok は空なら false)。
        let h = idx.find(&q("Track 01", "", Some(""), Some(200_000)));
        assert_eq!(h[0].kind, MatchKind::Weak);
    }

    /// 片側だけアーティストがある場合は従来どおり一致しない (空は何とも一致しない)。
    #[test]
    fn unknown_artist_does_not_match_known_artist() {
        let idx = MatchIndex::new(vec![
            untagged(1, "Song", Some(200_000)),
            row(2, "Song", "Artist", "Album", Some(200_000)),
        ]);
        // タグ付きのクエリ → タグ付きの 2 だけ (未タグの 1 は出ない)。
        let h = idx.find(&q("Song", "Artist", Some("Album"), Some(200_000)));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].track_id, 2);
        assert_eq!(h[0].kind, MatchKind::Exact);
        // 未タグのクエリ → 未タグの 1 だけ (Weak)。
        let h = idx.find(&q("Song", "", None, Some(200_000)));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].track_id, 1);
        assert_eq!(h[0].kind, MatchKind::Weak);
    }
}
