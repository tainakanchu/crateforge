//! API の書き込み後に WebView へ送る `library-changed` を間引く。
//!
//! 外部スクリプトが PATCH / artwork PUT を数百件続けて送ると、1 リクエストごとに
//! `library-changed` が飛び、WebView が毎回プレイリスト・曲一覧・件数を取り直して固まっていた。
//! ここでは窓 ([`COALESCE_WINDOW`]) の間に来た通知を 1 回にまとめる。
//!
//! - 先頭: 直前の送信から窓以上空いていれば、その場で送る (単発のリクエストは遅れない)。
//! - 末尾: 窓の中で来た通知は 1 つにまとめ、窓が明けた時点で 1 回だけ送る。
//!   まとめるときは `artworkChanged` を OR し、`playlistId` は全部同じときだけ残す
//!   (違えば `null` = どのプレイリストかは特定しない)。
//!
//! 判定は [`Coalescer`] (時刻を引数で受ける純粋なロジック) に切り出してテストする。
//!
//! ## 反映を遅らせる (`?notify=false`)
//! 書き込み系のリクエストに `?notify=false` を付けると、そのリクエストでは通知を送らず
//! [`HeldChanges`] (`ApiState::held_changes`) にためる (中身は上と同じ規則でまとめる)。
//! `POST /api/library/notify` でためた分を 1 回だけ送ってクリアする。
//! リクエスト単位の指定は [`notify_option`] ミドルウェアがタスクローカルに載せ、
//! `ApiState::notify_*` が [`notify_suppressed`] で読む (各ハンドラの引数は変えない)。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 通知をまとめる窓。連続した書き込みの間は、およそこの間隔で 1 回ずつ送る。
pub(crate) const COALESCE_WINDOW: Duration = Duration::from_millis(500);

/// `library-changed` の中身。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LibraryChange {
    /// 変わったプレイリスト。特定しない (ライブラリ全体) なら `None`。
    pub playlist_id: Option<i64>,
    /// 埋め込みアートワークが変わりうる書き込みか (WebView はこのときだけ画像を取り直す #213)。
    pub artwork_changed: bool,
}

impl LibraryChange {
    /// 2 つの通知を 1 つにまとめる。
    pub(crate) fn merge(self, other: Self) -> Self {
        LibraryChange {
            playlist_id: if self.playlist_id == other.playlist_id {
                self.playlist_id
            } else {
                None
            },
            artwork_changed: self.artwork_changed || other.artwork_changed,
        }
    }

    /// イベントのペイロード。
    pub(crate) fn payload(&self) -> serde_json::Value {
        serde_json::json!({
            "playlistId": self.playlist_id,
            "artworkChanged": self.artwork_changed,
        })
    }
}

/// [`Coalescer::push`] の結果 = 呼び出し側がすること。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushAction {
    /// すぐに送る。
    EmitNow(LibraryChange),
    /// 保留した。指定時刻に [`Coalescer::fire`] を呼ぶタイマーを仕掛ける。
    ArmTimer(Instant),
    /// 既に保留中の通知にまとめた (タイマーは仕掛け済み)。
    Merged,
}

/// 先頭 + 末尾で送る間引きの状態。保留中の通知があるとき、かつそのときだけタイマーが仕掛かっている。
#[derive(Debug, Default)]
pub(crate) struct Coalescer {
    last_emit: Option<Instant>,
    pending: Option<LibraryChange>,
}

impl Coalescer {
    pub(crate) const fn new() -> Self {
        Coalescer {
            last_emit: None,
            pending: None,
        }
    }

    /// 通知が来たときに呼ぶ。
    pub(crate) fn push(
        &mut self,
        now: Instant,
        change: LibraryChange,
        window: Duration,
    ) -> PushAction {
        if let Some(p) = self.pending {
            self.pending = Some(p.merge(change));
            return PushAction::Merged;
        }
        match self.last_emit {
            Some(last) if now < last + window => {
                self.pending = Some(change);
                PushAction::ArmTimer(last + window)
            }
            _ => {
                self.last_emit = Some(now);
                PushAction::EmitNow(change)
            }
        }
    }

    /// タイマーが切れたときに呼ぶ。保留していた通知 (まとめた結果) を返す。
    pub(crate) fn fire(&mut self, now: Instant) -> Option<LibraryChange> {
        let change = self.pending.take()?;
        self.last_emit = Some(now);
        Some(change)
    }
}

/// `?notify=false` の書き込みで送らずにおいた通知 (まとめた内容)。`None` = ためた分なし。
pub type HeldChanges = Arc<Mutex<Option<LibraryChange>>>;

/// 送らずにためる。既にためた分があればまとめる。
pub(crate) fn hold(held: &HeldChanges, change: LibraryChange) {
    let mut h = held.lock().unwrap_or_else(|e| e.into_inner());
    *h = Some(match *h {
        Some(prev) => prev.merge(change),
        None => change,
    });
}

/// ためた分を取り出してクリアする。
pub(crate) fn take_held(held: &HeldChanges) -> Option<LibraryChange> {
    held.lock().unwrap_or_else(|e| e.into_inner()).take()
}

tokio::task_local! {
    /// このリクエストでは通知を送らない (`?notify=false`)。
    static SUPPRESS_NOTIFY: bool;
}

/// 今のリクエストが `?notify=false` か。リクエストの外 (バックグラウンドのジョブなど) では false。
pub(crate) fn notify_suppressed() -> bool {
    SUPPRESS_NOTIFY.try_with(|v| *v).unwrap_or(false)
}

/// クエリ文字列に `notify=false` (または `notify=0`) があるか。
pub(crate) fn query_disables_notify(query: Option<&str>) -> bool {
    query.is_some_and(|q| {
        q.split('&').any(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            k == "notify" && matches!(v, "false" | "0")
        })
    })
}

/// `?notify=false` をリクエストの処理中だけタスクローカルに載せるミドルウェア。
pub(crate) async fn notify_option(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let suppress = query_disables_notify(req.uri().query());
    SUPPRESS_NOTIFY.scope(suppress, next.run(req)).await
}

/// アプリ全体で 1 つ (API サーバーを止めて立て直しても間引きの状態は引き継ぐ)。
static COALESCER: Mutex<Coalescer> = Mutex::new(Coalescer::new());

fn emit(app: &tauri::AppHandle, change: LibraryChange) {
    use tauri::Emitter; // v2 では emit は Emitter トレイト経由。
    let _ = app.emit("library-changed", change.payload());
}

/// `library-changed` を間引いて送る。emit 失敗は無視する。
pub(crate) fn notify(app: &tauri::AppHandle, change: LibraryChange) {
    let action = COALESCER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(Instant::now(), change, COALESCE_WINDOW);
    match action {
        PushAction::EmitNow(c) => emit(app, c),
        PushAction::ArmTimer(at) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
                let pending = COALESCER
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .fire(Instant::now());
                if let Some(c) = pending {
                    emit(&app, c);
                }
            });
        }
        PushAction::Merged => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: Duration = Duration::from_millis(500);

    fn plain() -> LibraryChange {
        LibraryChange {
            playlist_id: None,
            artwork_changed: false,
        }
    }

    fn artwork() -> LibraryChange {
        LibraryChange {
            playlist_id: None,
            artwork_changed: true,
        }
    }

    fn playlist(id: i64) -> LibraryChange {
        LibraryChange {
            playlist_id: Some(id),
            artwork_changed: false,
        }
    }

    #[test]
    fn first_notification_is_sent_immediately() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        assert_eq!(c.push(t0, plain(), W), PushAction::EmitNow(plain()));
        // 窓が明けた後の単発も遅らせない。
        assert_eq!(
            c.push(t0 + W, artwork(), W),
            PushAction::EmitNow(artwork())
        );
    }

    #[test]
    fn burst_within_window_is_sent_once_at_window_end() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        assert!(matches!(c.push(t0, plain(), W), PushAction::EmitNow(_)));
        let ms = Duration::from_millis;
        assert_eq!(c.push(t0 + ms(10), plain(), W), PushAction::ArmTimer(t0 + W));
        // 2 件目以降はまとめるだけ (タイマーを仕掛け直さない)。
        for i in 2..100 {
            assert_eq!(c.push(t0 + ms(10 + i), plain(), W), PushAction::Merged);
        }
        assert_eq!(c.fire(t0 + W), Some(plain()));
        // 送った後は保留が無いので、タイマーが重ねて切れても何も送らない。
        assert_eq!(c.fire(t0 + W + ms(1)), None);
        // 末尾で送った時刻から窓を数える。
        assert_eq!(
            c.push(t0 + W + ms(100), plain(), W),
            PushAction::ArmTimer(t0 + W + W)
        );
    }

    #[test]
    fn merged_notification_keeps_artwork_flag() {
        let mut c = Coalescer::new();
        let t0 = Instant::now();
        c.push(t0, plain(), W);
        let ms = Duration::from_millis;
        c.push(t0 + ms(1), plain(), W);
        assert_eq!(c.push(t0 + ms(2), artwork(), W), PushAction::Merged);
        assert_eq!(c.push(t0 + ms(3), plain(), W), PushAction::Merged);
        assert_eq!(c.fire(t0 + W), Some(artwork()));
    }

    #[test]
    fn merge_keeps_playlist_id_only_when_all_equal() {
        assert_eq!(playlist(3).merge(playlist(3)), playlist(3));
        assert_eq!(playlist(3).merge(playlist(4)), plain());
        assert_eq!(playlist(3).merge(plain()), plain());
        assert_eq!(
            playlist(3).merge(artwork()),
            LibraryChange {
                playlist_id: None,
                artwork_changed: true
            }
        );
    }

    #[test]
    fn notify_query_parsing() {
        assert!(query_disables_notify(Some("notify=false")));
        assert!(query_disables_notify(Some("effectiveBpm=true&notify=0")));
        assert!(!query_disables_notify(Some("notify=true")));
        assert!(!query_disables_notify(Some("notify")));
        assert!(!query_disables_notify(Some("xnotify=false")));
        assert!(!query_disables_notify(None));
    }

    #[test]
    fn held_changes_are_merged_and_taken_once() {
        let held = HeldChanges::default();
        assert_eq!(take_held(&held), None);
        hold(&held, playlist(1));
        hold(&held, artwork());
        assert_eq!(
            take_held(&held),
            Some(LibraryChange {
                playlist_id: None,
                artwork_changed: true
            })
        );
        assert_eq!(take_held(&held), None);
    }

    #[tokio::test]
    async fn suppression_is_scoped_to_the_request() {
        assert!(!notify_suppressed());
        SUPPRESS_NOTIFY
            .scope(true, async { assert!(notify_suppressed()) })
            .await;
        assert!(!notify_suppressed());
    }

    #[test]
    fn payload_shape() {
        assert_eq!(
            playlist(7).payload(),
            serde_json::json!({ "playlistId": 7, "artworkChanged": false })
        );
        assert_eq!(
            artwork().payload(),
            serde_json::json!({ "playlistId": null, "artworkChanged": true })
        );
    }
}
