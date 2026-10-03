//! 解析ベクトルによる類似度ランキングと、DJ 向けのハーモニック/テンポ互換判定。

use crate::models::TrackAnalysis;

pub struct SimilarOpts {
    /// BPM 許容差 (base BPM に対する割合, 例 0.08)。None ならフィルタしない。
    pub bpm_tol: Option<f64>,
    /// Camelot 互換キーのみに絞るか。
    pub key_compatible: bool,
    /// エネルギー許容差 (0..1 の絶対差)。None ならフィルタしない。
    pub energy_tol: Option<f64>,
}

/// 特徴ベクトル間のユークリッド距離 (小さいほど似ている)。
pub fn euclidean(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    let mut s = 0.0;
    for i in 0..n {
        let d = a[i] - b[i];
        s += d * d;
    }
    s.sqrt()
}

/// Camelot コード ("8A" 等) を (番号 1..=12, is_minor=A 面) に分解する。
pub fn parse_camelot(s: &str) -> Option<(u8, bool)> {
    let s = s.trim();
    if s.len() < 2 {
        return None;
    }
    let (num_part, letter) = s.split_at(s.len() - 1);
    let is_minor = match letter {
        "A" | "a" => true,
        "B" | "b" => false,
        _ => return None,
    };
    let num: u8 = num_part.parse().ok()?;
    if (1..=12).contains(&num) {
        Some((num, is_minor))
    } else {
        None
    }
}

/// Camelot コードを正規化する ("8a" / " 08A " → "8A")。不正なら None。
/// 手動 Key 上書きの保存・検索で表記ゆれを吸収するために使う。
pub fn normalize_camelot(s: &str) -> Option<String> {
    let (num, is_minor) = parse_camelot(s)?;
    Some(format!("{num}{}", if is_minor { 'A' } else { 'B' }))
}

/// 検索用に Key 表記を Camelot へ正規化する (大文字小文字は無視)。
/// - Camelot: "8A" / "08b"
/// - Open Key: "1m" (短調) / "1d" (長調)。1m = 8A, 1d = 8B
/// - Classic: "Am" "F#m" "Abm" "C" "Db" など。異名同音 ("G#m" = "Abm", "A#" = "Bb") も同一視する。
///
/// どれにも当てはまらなければ None。
pub fn normalize_key_to_camelot(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(c) = normalize_camelot(t) {
        return Some(c);
    }
    let lower = t.to_ascii_lowercase();
    // Open Key: 数字 + m/d。
    if let Some(num_part) = lower.strip_suffix('m').or_else(|| lower.strip_suffix('d')) {
        if !num_part.is_empty() && num_part.bytes().all(|b| b.is_ascii_digit()) {
            let n: u8 = num_part.parse().ok()?;
            if !(1..=12).contains(&n) {
                return None;
            }
            let minor = lower.ends_with('m');
            let camelot = (n + 6) % 12 + 1;
            return Some(format!("{camelot}{}", if minor { 'A' } else { 'B' }));
        }
    }
    // Classic: 音名 (A-G) + 任意の #/b + 任意の m (短調)。
    let mut chars = lower.chars();
    let base: i32 = match chars.next()? {
        'c' => 0,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return None,
    };
    let rest = chars.as_str();
    let (accidental, rest) = match rest.chars().next() {
        Some('#') => (1, &rest[1..]),
        Some('b') => (-1, &rest[1..]),
        _ => (0, rest),
    };
    let minor = match rest {
        "" => false,
        "m" => true,
        _ => return None,
    };
    let pc = (base + accidental).rem_euclid(12);
    // 短調は平行調 (長調 +3 半音) の Camelot 番号を使う。
    let major_pc = if minor { (pc + 3) % 12 } else { pc };
    // 長調トニックの pitch class (C=0 ...) → Camelot 番号。
    const NUM: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
    Some(format!(
        "{}{}",
        NUM[major_pc as usize],
        if minor { 'A' } else { 'B' }
    ))
}

/// Camelot コード → 解析器と同じ形式のキー名 ("8A" → "A minor", "8B" → "C major")。
/// 音名はシャープ表記 (analyzer/features.rs の key_name と一致)。
pub fn camelot_to_key_name(s: &str) -> Option<String> {
    // Camelot 番号 (1..=12) ごとのトニック。features.rs の camelot_code の逆写像。
    const MINOR: [&str; 12] = [
        "G#", "D#", "A#", "F", "C", "G", "D", "A", "E", "B", "F#", "C#",
    ];
    const MAJOR: [&str; 12] = [
        "B", "F#", "C#", "G#", "D#", "A#", "F", "C", "G", "D", "A", "E",
    ];
    let (num, is_minor) = parse_camelot(s)?;
    let idx = (num - 1) as usize;
    Some(if is_minor {
        format!("{} minor", MINOR[idx])
    } else {
        format!("{} major", MAJOR[idx])
    })
}

/// Camelot ミキシング互換: 同番号 (同キー or 平行調 A↔B) か、隣接番号 (±1, 環状) で同種。
pub fn camelot_compatible(a: &str, b: &str) -> bool {
    match (parse_camelot(a), parse_camelot(b)) {
        (Some((na, ma)), Some((nb, mb))) => {
            if na == nb {
                return true;
            }
            if ma == mb {
                let d = (na as i16 - nb as i16).rem_euclid(12);
                return d.min(12 - d) == 1;
            }
            false
        }
        _ => false,
    }
}

/// BPM 互換: base の ±tol 以内。ハーフ/ダブルテンポ (×2, ÷2) も許容する。
/// どちらかが不明 (<=0) のときは除外しない。
pub fn bpm_compatible(base: f64, other: f64, tol: f64) -> bool {
    if base <= 0.0 || other <= 0.0 {
        return true;
    }
    let within = |x: f64| (base - x).abs() <= base * tol;
    within(other) || within(other * 2.0) || within(other / 2.0)
}

fn passes(base: &TrackAnalysis, c: &TrackAnalysis, opts: &SimilarOpts) -> bool {
    if let Some(tol) = opts.bpm_tol {
        if let (Some(bb), Some(cb)) = (base.bpm, c.bpm) {
            if !bpm_compatible(bb, cb, tol) {
                return false;
            }
        }
    }
    if opts.key_compatible {
        // 手動上書きがあればそれを優先する (実効キー)。
        if let (Some(bk), Some(ck)) = (base.effective_key_camelot(), c.effective_key_camelot()) {
            if !camelot_compatible(bk, ck) {
                return false;
            }
        }
        // どちらかキー不明なら判定できないので除外しない。
    }
    if let Some(etol) = opts.energy_tol {
        if let (Some(be), Some(ce)) = (base.energy, c.energy) {
            if (be - ce).abs() > etol {
                return false;
            }
        }
    }
    true
}

/// 貪欲最近傍で「滑らかな並び」を作る (A→B の流れを作る DJ セット用)。
/// 先頭から始め、毎回いちばん近い未訪問曲を次に置く。O(n^2) だが crate 規模なら十分。
pub fn smooth_order(items: &[(i64, Vec<f64>)]) -> Vec<i64> {
    let n = items.len();
    if n <= 2 {
        return items.iter().map(|(id, _)| *id).collect();
    }
    let mut visited = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur = 0usize;
    visited[0] = true;
    order.push(items[0].0);
    for _ in 1..n {
        let mut best: Option<usize> = None;
        let mut best_d = f64::MAX;
        for (j, visited_j) in visited.iter().enumerate() {
            if *visited_j {
                continue;
            }
            let d = euclidean(&items[cur].1, &items[j].1);
            if d < best_d {
                best_d = d;
                best = Some(j);
            }
        }
        if let Some(j) = best {
            visited[j] = true;
            order.push(items[j].0);
            cur = j;
        }
    }
    order
}

/// base に似た候補を距離昇順で最大 `limit` 件返す ((track_id, distance))。
pub fn rank_similar(
    base: &TrackAnalysis,
    candidates: &[TrackAnalysis],
    opts: &SimilarOpts,
    limit: usize,
) -> Vec<(i64, f64)> {
    let mut scored: Vec<(i64, f64)> = candidates
        .iter()
        .filter(|c| c.track_id != base.track_id && !c.vector.is_empty())
        .filter(|c| passes(base, c, opts))
        .map(|c| (c.track_id, euclidean(&base.vector, &c.vector)))
        .collect();
    scored.sort_by(|a, b| a.1.total_cmp(&b.1));
    scored.truncate(limit);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_key_to_camelot_all_notations() {
        let n = |s: &str| normalize_key_to_camelot(s);
        assert_eq!(n("8a").as_deref(), Some("8A"));
        assert_eq!(n("1m").as_deref(), Some("8A"));
        assert_eq!(n("1D").as_deref(), Some("8B"));
        assert_eq!(n("6m").as_deref(), Some("1A"));
        assert_eq!(n("12d").as_deref(), Some("7B"));
        assert_eq!(n("Am").as_deref(), Some("8A"));
        assert_eq!(n("F#m").as_deref(), Some("11A"));
        assert_eq!(n("abm").as_deref(), Some("1A"));
        assert_eq!(n("G#m").as_deref(), Some("1A"));
        assert_eq!(n("C").as_deref(), Some("8B"));
        assert_eq!(n("db").as_deref(), Some("3B"));
        assert_eq!(n("C#").as_deref(), Some("3B"));
        assert_eq!(n("A#").as_deref(), Some("6B"));
        assert_eq!(n("Bb").as_deref(), Some("6B"));
        assert_eq!(n("B").as_deref(), Some("1B"));
        assert_eq!(n("Bbm").as_deref(), Some("3A"));
        assert_eq!(n("Fb").as_deref(), Some("12B"));
        assert_eq!(n("13m"), None);
        assert_eq!(n("0d"), None);
        assert_eq!(n("H"), None);
        assert_eq!(n("Amm"), None);
        assert_eq!(n(""), None);
    }

    /// Classic 表記が解析器の key_name / Camelot 逆写像と全 24 キーで一致すること。
    #[test]
    fn normalize_key_to_camelot_round_trips_all_keys() {
        for n in 1..=12u8 {
            for l in ["A", "B"] {
                let c = format!("{n}{l}");
                let name = camelot_to_key_name(&c).unwrap();
                let (tonic, mode) = name.split_once(' ').unwrap();
                let classic = if mode == "minor" {
                    format!("{tonic}m")
                } else {
                    tonic.to_string()
                };
                assert_eq!(
                    normalize_key_to_camelot(&classic).as_deref(),
                    Some(c.as_str()),
                    "{classic}"
                );
            }
        }
    }

    #[test]
    fn normalize_camelot_and_key_name() {
        assert_eq!(normalize_camelot(" 8a ").as_deref(), Some("8A"));
        assert_eq!(normalize_camelot("08B").as_deref(), Some("8B"));
        assert_eq!(normalize_camelot("13A"), None);
        assert_eq!(normalize_camelot("Am"), None);
        assert_eq!(camelot_to_key_name("8A").as_deref(), Some("A minor"));
        assert_eq!(camelot_to_key_name("8B").as_deref(), Some("C major"));
        assert_eq!(camelot_to_key_name("1A").as_deref(), Some("G# minor"));
        assert_eq!(camelot_to_key_name("11A").as_deref(), Some("F# minor"));
        assert_eq!(camelot_to_key_name("12B").as_deref(), Some("E major"));
        assert_eq!(camelot_to_key_name("x"), None);
    }

    #[test]
    fn parse_camelot_works() {
        assert_eq!(parse_camelot("8A"), Some((8, true)));
        assert_eq!(parse_camelot("12B"), Some((12, false)));
        assert_eq!(parse_camelot("13A"), None);
        assert_eq!(parse_camelot("X"), None);
        assert_eq!(parse_camelot("0B"), None);
    }

    #[test]
    fn camelot_rules() {
        assert!(camelot_compatible("8A", "8A")); // same
        assert!(camelot_compatible("8A", "8B")); // relative major/minor
        assert!(camelot_compatible("8A", "9A")); // +1
        assert!(camelot_compatible("8A", "7A")); // -1
        assert!(camelot_compatible("12A", "1A")); // wrap
        assert!(camelot_compatible("1A", "12A")); // wrap both ways
        assert!(!camelot_compatible("8A", "10A")); // +2
        assert!(!camelot_compatible("8A", "9B")); // diagonal
    }

    #[test]
    fn bpm_rules() {
        assert!(bpm_compatible(128.0, 128.0, 0.08));
        assert!(bpm_compatible(128.0, 126.0, 0.08));
        assert!(bpm_compatible(128.0, 64.0, 0.06)); // half-tempo
        assert!(bpm_compatible(120.0, 240.0, 0.06)); // double-tempo
        assert!(!bpm_compatible(128.0, 100.0, 0.06));
        assert!(bpm_compatible(0.0, 100.0, 0.06)); // unknown -> allowed
    }

    #[test]
    fn euclidean_basic() {
        assert!((euclidean(&[0.0, 0.0], &[3.0, 4.0]) - 5.0).abs() < 1e-9);
        assert_eq!(euclidean(&[], &[]), 0.0);
    }

    #[test]
    fn smooth_order_is_nearest_neighbor_chain() {
        // 1D 上に 0,10,1,11 を置くと 0→1→10→11 の順に並ぶはず。
        let items = vec![
            (1i64, vec![0.0]),
            (2, vec![10.0]),
            (3, vec![1.0]),
            (4, vec![11.0]),
        ];
        assert_eq!(smooth_order(&items), vec![1, 3, 2, 4]);
    }

    #[test]
    fn ranking_orders_by_distance_and_filters() {
        let mk = |id: i64, v: Vec<f64>, bpm: f64, key: &str| TrackAnalysis {
            track_id: id,
            version: 1,
            analyzed_at: String::new(),
            bpm: Some(bpm),
            key_camelot: Some(key.to_string()),
            key_name: None,
            key_camelot_user: None,
            energy: Some(0.5),
            loudness_lufs: None,
            replaygain_db: None,
            vector: v,
            peaks: Vec::new(),
        };
        let base = mk(1, vec![0.0, 0.0], 128.0, "8A");
        let cands = vec![
            mk(2, vec![0.1, 0.0], 128.0, "8A"),  // closest + compatible
            mk(3, vec![0.5, 0.0], 127.0, "9A"),  // farther + compatible
            mk(4, vec![0.05, 0.0], 128.0, "2A"), // close but key-incompatible
        ];
        let opts = SimilarOpts {
            bpm_tol: Some(0.08),
            key_compatible: true,
            energy_tol: None,
        };
        let ranked = rank_similar(&base, &cands, &opts, 10);
        // 4 はキー非互換で除外、2 が 3 より近い。
        assert_eq!(
            ranked.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }
}
