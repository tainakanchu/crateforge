//! rating 列 (0〜100、★1 つ = 20) と星の相互変換。
//!
//! 変換は経路ごとに丸め方が違う。**ここでは現行の挙動をそのまま名前を分けて残す**
//! (丸めの統一は docs/refactor/design.md フェーズ 2 の R1 で行う。それまで関数どうしを
//! 置き換えないこと):
//!
//! | 関数 | 使う場所 | rating 65 の扱い |
//! |---|---|---|
//! | [`rating_to_stars_nearest_half`] | スマートプレイリストの評価 | 最寄りの半星 → 3.5 |
//! | [`rating_to_stars_exact`] | YAML ルール / iTunes 条件の境界値の変換 | 割るだけ → 3.25 |
//! | [`rating_to_whole_stars`] | USB エクスポート (整数星) | 半星は切り上げ → 3 |
//! | [`star_bucket`] / [`parse_star_range`] | 検索構文 `rating:` | 区間 (`rating:3` = 60〜79) |

/// 0-100 の rating を 0..5 の星 (0.5 刻み) に **最寄りの半星へ丸める**。
/// フロントの `ratingToStars` と同じ式。スマートプレイリストの条件評価が使う。
pub fn rating_to_stars_nearest_half(r: i64) -> f64 {
    (r.clamp(0, 100) as f64 / 10.0).round() / 2.0
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 3 つの「rating → 星」は丸め方が違う。フェーズ 2 (R1) まではこの差を保つ。
    #[test]
    fn rating_to_stars_variants_keep_their_rounding() {
        // (rating, 最寄りの半星, 割るだけ, 整数星)
        let cases = [
            (0, 0.0, 0.0, 0),
            (10, 0.5, 0.5, 1),
            (19, 1.0, 0.95, 1),
            (20, 1.0, 1.0, 1),
            (65, 3.5, 3.25, 3),
            (70, 3.5, 3.5, 4),
            (74, 3.5, 3.7, 4),
            (75, 4.0, 3.75, 4),
            (100, 5.0, 5.0, 5),
        ];
        for (r, half, exact, whole) in cases {
            assert_eq!(rating_to_stars_nearest_half(r), half, "nearest half of {r}");
            assert!(
                (rating_to_stars_exact(r as f64) - exact).abs() < 1e-9,
                "exact of {r}"
            );
            assert_eq!(rating_to_whole_stars(r), whole, "whole of {r}");
        }
        // 範囲外は丸める側だけが 0..100 に収める (割るだけの変換は収めない)。
        assert_eq!(rating_to_stars_nearest_half(250), 5.0);
        assert_eq!(rating_to_stars_nearest_half(-5), 0.0);
        assert_eq!(rating_to_whole_stars(250), 5);
        assert_eq!(rating_to_whole_stars(-5), 0);
        assert_eq!(rating_to_stars_exact(250.0), 12.5);
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
