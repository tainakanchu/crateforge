//! 再生操作の規則のうち、再生系 (`AudioPlayer` / Cast) に触らない純粋な判断。
//!
//! 実際の再生は `AppHandle` に載った再生系が行うので、ここには「何をするか」だけを置く。
//! GUI のコマンド (`commands::playback`) と HTTP のリモート操作 (`/api/remote/*`) が同じ判断を使う。

/// 「前の曲」で、これを **超えて** 再生していたら前の曲へ戻らず今の曲を頭から再生し直す (ミリ秒)。
pub const PREV_RESTART_THRESHOLD_MS: u64 = 3000;

/// 「前の曲」を押したときにすること。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrevAction {
    /// 今の曲を頭から再生し直す (キュー上の位置は動かさない)。
    RestartCurrent(i64),
    /// キューの前の曲へ戻る。
    Previous,
}

/// 「前の曲」の規則 (iTunes 流儀): 今の曲を 3 秒を超えて再生していれば頭出し、そうでなければ前の曲。
/// 再生中の曲が無ければ常に前の曲。`position_ms` は有効な再生先 (Cast 中は Cast) の再生位置。
pub fn prev_action(position_ms: u64, current_track_id: Option<i64>) -> PrevAction {
    match current_track_id {
        Some(track_id) if position_ms > PREV_RESTART_THRESHOLD_MS => {
            PrevAction::RestartCurrent(track_id)
        }
        _ => PrevAction::Previous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prev_restarts_only_after_three_seconds() {
        assert_eq!(prev_action(0, Some(7)), PrevAction::Previous);
        assert_eq!(prev_action(2999, Some(7)), PrevAction::Previous);
        // ちょうど 3 秒はまだ「前の曲」。
        assert_eq!(prev_action(3000, Some(7)), PrevAction::Previous);
        assert_eq!(prev_action(3001, Some(7)), PrevAction::RestartCurrent(7));
        assert_eq!(prev_action(600_000, Some(-2)), PrevAction::RestartCurrent(-2));
    }

    #[test]
    fn prev_without_current_track_goes_back() {
        assert_eq!(prev_action(0, None), PrevAction::Previous);
        assert_eq!(prev_action(10_000, None), PrevAction::Previous);
    }
}
