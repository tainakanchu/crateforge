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
        if let (Some(bk), Some(ck)) = (&base.key_camelot, &c.key_camelot) {
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
    fn ranking_orders_by_distance_and_filters() {
        let mk = |id: i64, v: Vec<f64>, bpm: f64, key: &str| TrackAnalysis {
            track_id: id,
            version: 1,
            analyzed_at: String::new(),
            bpm: Some(bpm),
            key_camelot: Some(key.to_string()),
            key_name: None,
            energy: Some(0.5),
            loudness_lufs: None,
            replaygain_db: None,
            vector: v,
        };
        let base = mk(1, vec![0.0, 0.0], 128.0, "8A");
        let cands = vec![
            mk(2, vec![0.1, 0.0], 128.0, "8A"), // closest + compatible
            mk(3, vec![0.5, 0.0], 127.0, "9A"), // farther + compatible
            mk(4, vec![0.05, 0.0], 128.0, "2A"), // close but key-incompatible
        ];
        let opts = SimilarOpts {
            bpm_tol: Some(0.08),
            key_compatible: true,
            energy_tol: None,
        };
        let ranked = rank_similar(&base, &cands, &opts, 10);
        // 4 はキー非互換で除外、2 が 3 より近い。
        assert_eq!(ranked.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![2, 3]);
    }
}
