//! 自然順 (natural order) の文字列比較 (D10)。
//!
//! 曲名・アーティスト・アルバムの並びで "Bulk Song 2" < "Bulk Song 10" となるよう、
//! 連続した ASCII 数字を数値として比べる。文字は大文字小文字を区別しない
//! (従来の `COLLATE NOCASE` と同じ感覚。非 ASCII も小文字化して比べる)。
//!
//! SQLite には `NATSORT` 照合順序として登録し (`db::register_functions`)、
//! 一覧のソート (`ORDER BY name COLLATE NATSORT`) とスマートプレイリストの並び
//! (`smart::compare_field`) で同じ比較を使う。
//!
//! 性能: 確保 (allocation) をせず 1 文字ずつ比べる。10 万曲の ORDER BY でも
//! 比較回数は n log n ≒ 170 万回程度で、1 回あたり数十 ns に収まる (テスト参照)。

use std::cmp::Ordering;

#[inline]
fn fold(c: char) -> char {
    if c.is_ascii() {
        c.to_ascii_lowercase()
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

/// 自然順で比較する。数字の並びは数値として比べ (先頭の 0 は無視、値が同じなら 0 の
/// 少ない方が先)、それ以外の文字は大文字小文字を区別せずに比べる。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        let (ca, cb) = match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => (ca, cb),
        };
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let mut zeros_a = 0usize;
            while ai.peek() == Some(&'0') {
                ai.next();
                zeros_a += 1;
            }
            let mut zeros_b = 0usize;
            while bi.peek() == Some(&'0') {
                bi.next();
                zeros_b += 1;
            }
            // 有効桁を先頭から比べる。桁数が多い方が大きい。桁数が同じなら最初に違った桁で決まる。
            let mut first_diff = Ordering::Equal;
            loop {
                let da = ai.peek().copied().filter(char::is_ascii_digit);
                let db = bi.peek().copied().filter(char::is_ascii_digit);
                match (da, db) {
                    (Some(x), Some(y)) => {
                        if first_diff == Ordering::Equal {
                            first_diff = x.cmp(&y);
                        }
                        ai.next();
                        bi.next();
                    }
                    (Some(_), None) => return Ordering::Greater,
                    (None, Some(_)) => return Ordering::Less,
                    (None, None) => break,
                }
            }
            if first_diff != Ordering::Equal {
                return first_diff;
            }
            if zeros_a != zeros_b {
                return zeros_a.cmp(&zeros_b);
            }
            continue;
        }
        let (la, lb) = (fold(ca), fold(cb));
        if la != lb {
            return la.cmp(&lb);
        }
        ai.next();
        bi.next();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut v: Vec<&str>) -> Vec<&str> {
        v.sort_by(|a, b| natural_cmp(a, b));
        v
    }

    #[test]
    fn numbers_compare_by_value() {
        assert_eq!(
            sorted(vec!["Bulk Song 10", "Bulk Song 2", "Bulk Song 1", "Bulk Song 100"]),
            vec!["Bulk Song 1", "Bulk Song 2", "Bulk Song 10", "Bulk Song 100"]
        );
        assert_eq!(natural_cmp("Track 9", "Track 10"), Ordering::Less);
        assert_eq!(natural_cmp("a10b2", "a10b10"), Ordering::Less);
        // 先頭の 0 は値として無視し、同値なら 0 が少ない方が先。
        assert_eq!(natural_cmp("01", "1"), Ordering::Greater);
        assert_eq!(natural_cmp("007", "8"), Ordering::Less);
        assert_eq!(natural_cmp("0", "00"), Ordering::Less);
        assert_eq!(natural_cmp("0", "1"), Ordering::Less);
        // 非常に長い数字列でも桁あふれしない。
        assert_eq!(
            natural_cmp("x 99999999999999999999999", "x 100000000000000000000000"),
            Ordering::Less
        );
    }

    #[test]
    fn letters_ignore_case_like_nocase() {
        assert_eq!(natural_cmp("abc", "ABC"), Ordering::Equal);
        assert_eq!(natural_cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(natural_cmp("Ärger", "ärger"), Ordering::Equal);
        assert_eq!(natural_cmp("", "a"), Ordering::Less);
        assert_eq!(natural_cmp("song", "song 2"), Ordering::Less);
        // 数字は文字より前 (ASCII 順と同じ)。
        assert_eq!(natural_cmp("2 Unlimited", "ABBA"), Ordering::Less);
    }

    /// 10 万件のソートが現実的な時間で終わること (debug ビルドでも数百 ms 程度)。
    #[test]
    fn sorts_100k_quickly() {
        let mut v: Vec<String> = (0..100_000u32)
            .map(|i| format!("Bulk Song {} {}", (i * 7919) % 100_000, i % 13))
            .collect();
        let start = std::time::Instant::now();
        v.sort_by(|a, b| natural_cmp(a, b));
        let elapsed = start.elapsed();
        assert!(v.windows(2).all(|w| natural_cmp(&w[0], &w[1]) != Ordering::Greater));
        assert!(elapsed.as_secs() < 10, "{elapsed:?}");
    }
}
