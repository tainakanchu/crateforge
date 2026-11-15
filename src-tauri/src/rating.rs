//! rating 列 (0〜100、★1 つ = 20) と星の相互変換。
//!
//! 星で書かれた条件の意味は **検索構文 `rating:` の区間方式が唯一の規則** で、スマートプレイリストの
//! 条件も同じ判定を使う (docs/refactor/design.md フェーズ 2 の R1):
//!
//! | 条件 | 一致する rating |
//! |---|---|
//! | `3` (整数星) | 60〜79 (3 星と 3.5 星。`0` は 0〜19) |
//! | `3.5` (半星) | 70〜79 |
//! | `>=3.5` / `>3` / `<=2` / `<2.5` | 星を連続値 (rating ÷ 20) とみなした比較: 70 以上 / 61 以上 / 40 以下 / 49 以下 |
//!
//! | 関数 | 使う場所 |
//! |---|---|
//! | [`parse_star_range`] | 検索構文 `rating:` (SQL の BETWEEN に渡す区間) |
//! | [`rating_matches_stars`] | スマートプレイリストの条件 (同じ区間。半星の格子に無い値は rating ÷ 20 と比べる) |
//! | [`rating_to_stars_exact`] | YAML ルール / iTunes 条件の境界値 (0-100) を星に写す (割るだけ) |
//! | [`rating_to_whole_stars`] | USB エクスポートの整数星 (半星は切り上げ。CDJ 側の表現で、条件の判定ではない) |

/// rating 列に入れてよい値の範囲 (iTunes 互換)。
pub const RATING_RANGE: std::ops::RangeInclusive<i64> = 0..=100;

/// rating を [`RATING_RANGE`] に収める。星クリック (`set_rating`)・
/// `POST /api/tracks/{id}/rating`・GUI の Get Info が使う。`PATCH /api/tracks*` は収めずに
/// 範囲外を 400 で返す (`db::tracks::CheckedTrackEdit`)。
pub fn clamp_rating(rating: i64) -> i64 {
    rating.clamp(*RATING_RANGE.start(), *RATING_RANGE.end())
}

/// rating スケールの値を **丸めずに** 星へ (20 で割るだけ)。
/// YAML ルール・iTunes の Smart Criteria の境界値をスマート条件 (星) に写すのに使う。
pub fn rating_to_stars_exact(v: f64) -> f64 {
    v / 20.0
}

/// 0–100 → 0–5 の **整数星** (半星は切り上げ)。USB エクスポート用。
pub fn rating_to_whole_stars(r: i64) -> u8 {
    ((r.clamp(0, 100) + 10) / 20) as u8
}

/// 星の値 (0..=5, 0.5 刻み) を rating 列の 10 の倍数に。範囲外/半端な値は None。
pub fn parse_star_value(s: &str) -> Option<i64> {
    let v: f64 = s.trim().parse().ok()?;
    let doubled = v * 2.0;
    if !(0.0..=10.0).contains(&doubled) || (doubled - doubled.round()).abs() > 1e-9 {
        return None;
    }
    Some(doubled.round() as i64 * 10)
}

/// 星の値 1 つが表す rating 列の区間。整数星 n は従来どおり「n 〜 n.5 星」
/// (`n*20 ..= n*20+19`)、半星 n.5 は `n*20+10 ..= n*20+19`。5 は 100 で頭打ち。
pub fn star_bucket(r: i64) -> (i64, i64) {
    let hi = if r % 20 == 0 { r + 19 } else { r + 9 };
    (r, hi.min(100))
}

/// 星 (0..=5, 0.5 刻み #172) を rating 列 (0..=100) の範囲に写す。
/// - `4` / `3.5` — その星の区間 (`star_bucket`)。
/// - `3.5-5` — 下限の区間の先頭 〜 上限の区間の末尾。
/// - `>=3.5` `>3` `<=2` `<2.5` — 星を連続値 (rating/20) とみなした比較。
///
/// rating が NULL の曲は 0 星扱い (COALESCE) なので `rating:0` で未評価を拾える。
pub fn parse_star_range(s: &str) -> Option<(i64, i64)> {
    let s = s.trim();
    if let Some(v) = s.strip_prefix(">=") {
        return Some((parse_star_value(v)?, 100));
    }
    if let Some(v) = s.strip_prefix("<=") {
        return Some((0, parse_star_value(v)?));
    }
    if let Some(v) = s.strip_prefix('>') {
        let r = parse_star_value(v)?;
        return (r < 100).then_some((r + 1, 100));
    }
    if let Some(v) = s.strip_prefix('<') {
        let r = parse_star_value(v)?;
        return (r > 0).then_some((0, r - 1));
    }
    if let Some((a, b)) = s.split_once('-') {
        let (a, b) = (parse_star_value(a)?, parse_star_value(b)?);
        let (lo, hi) = (a.min(b), a.max(b));
        return Some((star_bucket(lo).0, star_bucket(hi).1));
    }
    Some(star_bucket(parse_star_value(s)?))
}

/// 星の条件の比較の種類 (スマートプレイリストの is / > / >= / < / <=)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StarCmp {
    Eq,
    Gt,
    Gte,
    Lt,
    Lte,
}

/// rating (0〜100) が「星 `stars` に対する比較 `cmp`」を満たすか。
///
/// `stars` が半星の格子 (0, 0.5, …, 5) に乗っていれば、検索構文と **同じ区間**
/// ([`parse_star_range`]) で判定する: `Eq 3` は 60〜79、`Eq 3.5` は 70〜79、`Gt 3` は 61 以上。
/// 格子に無い値 (YAML ルールの `gt: 65` = 3.25 星、iTunes の `> 49` = 2.45 星) は、星を連続値
/// (rating ÷ 20) とみなして比べる (`Eq` は rating がちょうどその値のときだけ)。
/// 格子上の比較演算はどちらで計算しても同じ結果になる (テストで固定)。
pub fn rating_matches_stars(rating: i64, cmp: StarCmp, stars: f64) -> bool {
    let rating = clamp_rating(rating);
    if cmp == StarCmp::Eq {
        if let Some(on_grid) = parse_star_value(&stars.to_string()) {
            let (lo, hi) = star_bucket(on_grid);
            return (lo..=hi).contains(&rating);
        }
    }
    let actual = rating_to_stars_exact(rating as f64);
    match cmp {
        StarCmp::Eq => (actual - stars).abs() < 1e-9,
        StarCmp::Gt => actual > stars,
        StarCmp::Gte => actual >= stars,
        StarCmp::Lt => actual < stars,
        StarCmp::Lte => actual <= stars,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// スマートプレイリストの判定 (rating_matches_stars) は、半星の格子上では検索構文の区間
    /// (parse_star_range) と全 rating・全演算子で一致する。
    #[test]
    fn smart_rating_matches_search_syntax_on_the_half_star_grid() {
        let ops = [
            (StarCmp::Eq, ""),
            (StarCmp::Gt, ">"),
            (StarCmp::Gte, ">="),
            (StarCmp::Lt, "<"),
            (StarCmp::Lte, "<="),
        ];
        for half in 0..=10 {
            let stars = half as f64 / 2.0;
            for (cmp, prefix) in ops {
                let range = parse_star_range(&format!("{prefix}{stars}"));
                for rating in 0..=100 {
                    let by_search = range.is_some_and(|(lo, hi)| (lo..=hi).contains(&rating));
                    assert_eq!(
                        rating_matches_stars(rating, cmp, stars),
                        by_search,
                        "rating {rating} {prefix}{stars}"
                    );
                }
            }
        }
    }

    /// 代表例: 整数星は半星を含む区間、半星は自分だけ、比較は連続値。
    #[test]
    fn smart_rating_examples() {
        // is 0 = 0〜19 (未評価〜0.5 星)。
        assert!(rating_matches_stars(0, StarCmp::Eq, 0.0));
        assert!(rating_matches_stars(10, StarCmp::Eq, 0.0));
        assert!(rating_matches_stars(19, StarCmp::Eq, 0.0));
        assert!(!rating_matches_stars(20, StarCmp::Eq, 0.0));
        // is 3 = 60〜79 (3.5 星も含む)、is 3.5 = 70〜79。
        assert!(rating_matches_stars(60, StarCmp::Eq, 3.0));
        assert!(rating_matches_stars(70, StarCmp::Eq, 3.0));
        assert!(!rating_matches_stars(80, StarCmp::Eq, 3.0));
        assert!(rating_matches_stars(70, StarCmp::Eq, 3.5));
        assert!(!rating_matches_stars(60, StarCmp::Eq, 3.5));
        // 10 の倍数でない rating: 65 は 3 星の区間 (最寄りの半星 3.5 には丸めない)。
        assert!(rating_matches_stars(65, StarCmp::Eq, 3.0));
        assert!(!rating_matches_stars(65, StarCmp::Eq, 3.5));
        assert!(!rating_matches_stars(65, StarCmp::Gte, 3.5));
        assert!(rating_matches_stars(65, StarCmp::Gt, 3.0));
        // 格子に無い境界値は rating ÷ 20 と比べる (iTunes の「> 49」= 2.45 星)。
        assert!(!rating_matches_stars(45, StarCmp::Gt, 2.45));
        assert!(rating_matches_stars(50, StarCmp::Gt, 2.45));
        assert!(rating_matches_stars(65, StarCmp::Eq, 3.25));
        assert!(!rating_matches_stars(60, StarCmp::Eq, 3.25));
        // 範囲外の rating は 0〜100 に収めてから判定する。
        assert!(rating_matches_stars(250, StarCmp::Eq, 5.0));
        assert!(rating_matches_stars(-5, StarCmp::Eq, 0.0));
    }

    /// 条件の判定に使わない 2 つの変換: 割るだけ (境界値の単位換算) と、USB エクスポートの整数星。
    #[test]
    fn unit_conversions() {
        assert_eq!(rating_to_stars_exact(65.0), 3.25);
        assert_eq!(rating_to_stars_exact(49.0), 2.45);
        assert_eq!(rating_to_stars_exact(250.0), 12.5);
        for (r, whole) in [
            (0, 0),
            (10, 1),
            (19, 1),
            (20, 1),
            (65, 3),
            (70, 4),
            (100, 5),
        ] {
            assert_eq!(rating_to_whole_stars(r), whole, "whole of {r}");
        }
        assert_eq!(rating_to_whole_stars(250), 5);
        assert_eq!(rating_to_whole_stars(-5), 0);
    }

    #[test]
    fn parse_star_value_accepts_half_steps_only() {
        assert_eq!(parse_star_value("0"), Some(0));
        assert_eq!(parse_star_value(" 3.5 "), Some(70));
        assert_eq!(parse_star_value("5"), Some(100));
        assert_eq!(parse_star_value("5.5"), None);
        assert_eq!(parse_star_value("-1"), None);
        assert_eq!(parse_star_value("3.2"), None);
        assert_eq!(parse_star_value("x"), None);
    }

    /// 検索構文は区間方式: 整数星 n は n〜n.5 星、半星は自分だけ。
    #[test]
    fn star_bucket_and_range() {
        assert_eq!(star_bucket(0), (0, 19));
        assert_eq!(star_bucket(60), (60, 79));
        assert_eq!(star_bucket(70), (70, 79));
        assert_eq!(star_bucket(100), (100, 100));

        assert_eq!(parse_star_range("4"), Some((80, 99)));
        assert_eq!(parse_star_range("3.5"), Some((70, 79)));
        assert_eq!(parse_star_range("3.5-5"), Some((70, 100)));
        assert_eq!(parse_star_range("5-3"), Some((60, 100)));
        assert_eq!(parse_star_range(">=3.5"), Some((70, 100)));
        assert_eq!(parse_star_range(">3"), Some((61, 100)));
        assert_eq!(parse_star_range("<=2"), Some((0, 40)));
        assert_eq!(parse_star_range("<2.5"), Some((0, 49)));
        assert_eq!(parse_star_range(">5"), None);
        assert_eq!(parse_star_range("<0"), None);
        assert_eq!(parse_star_range("abc"), None);
    }
}
