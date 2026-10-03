//! 再生キュー / 再生状態の永続化と起動時復元 (#159)。
//!
//! 書き込みは専用ワーカー (`persist_worker`) が 1 秒ごとに `AudioPlayer` のスナップショットを
//! 取り、前回書いた内容と比較して必要なときだけ行う:
//! - キュー (queue / order) が変わった → `play_queue` を書き直し + `playback_state` 更新
//! - 現在位置 (order_pos)・曲・shuffle / repeat / volume が変わった → `playback_state` のみ
//! - 再生位置だけが動いている → `POSITION_INTERVAL` ごとに `playback_state` のみ
//!
//! 1 秒刻みでまとめるので、音量スライダーのドラッグ等で連続変更されても書き込みは
//! 最大 1 回/秒 (= デバウンス)。アプリ終了時 (`RunEvent::Exit`) は `flush` で即時保存する。
//!
//! Preview / Audition (#119) 中は「本来の」曲・位置を上書きしない: preview 曲が
//! 読み込まれている間は、最後に保存した通常再生の曲・位置を据え置く。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::audio::{AudioPlayer, PlayerSnapshot};
use crate::commands::library::open_db;
use crate::commands::playback::PreviewMode;
use crate::db::playback::PersistedPlayback;
use crate::db::Database;

/// 位置だけが動いているときの保存間隔。
const POSITION_INTERVAL: Duration = Duration::from_secs(5);
/// ワーカーの確認間隔 (= 変更のデバウンス幅)。
const TICK: Duration = Duration::from_secs(1);

/// 永続化ワーカーの状態 (Tauri managed state)。
#[derive(Default)]
pub struct PlaybackPersister {
    inner: Mutex<PersisterInner>,
    /// 起動時に DB から再生状態を復元したか。フロントはこれが true なら
    /// shuffle / repeat / volume をストアから押し込まず、バックエンドから取り込む。
    restored: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
struct PersisterInner {
    /// ワーカー専用の DB 接続 (毎回 open してマイグレーションを走らせないよう保持)。
    db: Option<Database>,
    /// 最後に書いた内容。
    last: Option<PersistedPlayback>,
    last_write: Option<Instant>,
}

impl PlaybackPersister {
    pub fn restored(&self) -> bool {
        self.restored.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// 何を書くべきかの判定結果。
#[derive(Debug, PartialEq, Eq)]
enum WritePlan {
    None,
    StateOnly,
    QueueAndState,
}

/// スナップショット → 保存内容。preview 曲が読み込まれている間は、
/// 前回保存した通常再生の曲・位置を据え置く。
fn to_persisted(
    snap: &PlayerSnapshot,
    preview_active: bool,
    last: Option<&PersistedPlayback>,
) -> PersistedPlayback {
    let (track_id, position_ms) = if snap.preview || preview_active {
        last.map(|l| (l.track_id, l.position_ms))
            .unwrap_or((None, 0))
    } else {
        (snap.track_id, snap.position_ms)
    };
    PersistedPlayback {
        queue: snap.queue.clone(),
        order: snap.order.clone(),
        order_pos: snap.order_pos,
        track_id,
        position_ms,
        shuffle: snap.shuffle,
        repeat: snap.repeat,
        volume: snap.volume,
    }
}

fn plan(
    next: &PersistedPlayback,
    last: Option<&PersistedPlayback>,
    since_last_write: Option<Duration>,
    force: bool,
) -> WritePlan {
    let Some(last) = last else {
        return WritePlan::QueueAndState;
    };
    if next.queue != last.queue || next.order != last.order {
        return WritePlan::QueueAndState;
    }
    let state_changed = next.order_pos != last.order_pos
        || next.track_id != last.track_id
        || next.shuffle != last.shuffle
        || next.repeat != last.repeat
        || (next.volume - last.volume).abs() > f32::EPSILON;
    if state_changed {
        return WritePlan::StateOnly;
    }
    if next.position_ms != last.position_ms {
        let due = since_last_write.is_none_or(|d| d >= POSITION_INTERVAL);
        if force || due {
            return WritePlan::StateOnly;
        }
    }
    WritePlan::None
}

/// スナップショットを取り、必要なら保存する。`force` は位置の間引きを無視する (終了時)。
fn persist_once(app: &AppHandle, force: bool) {
    let snap = {
        let player = app.state::<Mutex<AudioPlayer>>();
        let Ok(p) = player.lock() else { return };
        p.snapshot()
    };
    let preview_active = app.state::<PreviewMode>().get();
    let persister = app.state::<PlaybackPersister>();
    let Ok(mut inner) = persister.inner.lock() else {
        return;
    };
    let next = to_persisted(&snap, preview_active, inner.last.as_ref());
    let since = inner.last_write.map(|t| t.elapsed());
    let include_queue = match plan(&next, inner.last.as_ref(), since, force) {
        WritePlan::None => return,
        WritePlan::StateOnly => false,
        WritePlan::QueueAndState => true,
    };
    if inner.db.is_none() {
        match open_db(app) {
            Ok(db) => inner.db = Some(db),
            Err(e) => {
                crate::logging::write_line("warn", &format!("playback persist: {}", e));
                return;
            }
        }
    }
    let Some(db) = inner.db.as_ref() else { return };
    match db.save_playback(&next, include_queue) {
        Ok(()) => {
            inner.last = Some(next);
            inner.last_write = Some(Instant::now());
        }
        Err(e) => {
            crate::logging::write_line("warn", &format!("playback persist failed: {}", e));
            // 接続が壊れている可能性があるので次回開き直す。
            inner.db = None;
        }
    }
}

/// 永続化ワーカー。`restore` の後に起動する (先に動くと空状態で上書きしてしまうため)。
pub fn persist_worker(app: AppHandle) {
    loop {
        std::thread::sleep(TICK);
        persist_once(&app, false);
    }
}

/// アプリ終了時の即時保存。
pub fn flush(app: &AppHandle) {
    persist_once(app, true);
}

/// 起動時に保存済みのキューと再生状態を `AudioPlayer` へ復元する。
/// 曲は一時停止状態で保存位置に読み込み、自動再生はしない。
pub fn restore(app: &AppHandle) {
    let db = match open_db(app) {
        Ok(db) => db,
        Err(e) => {
            crate::logging::write_line("warn", &format!("playback restore: {}", e));
            return;
        }
    };
    let saved = match db.load_playback() {
        Ok(Some(s)) => s,
        Ok(None) => return,
        Err(e) => {
            crate::logging::write_line("warn", &format!("playback restore failed: {}", e));
            return;
        }
    };

    // 曲の解決 (DB アクセス) はロックの外で済ませる。
    let track = saved.track_id.and_then(|tid| {
        let t = db.get_track_by_track_id(tid).ok().flatten()?;
        let path = t.location_path.clone().filter(|p| !p.is_empty())?;
        let gain_db = db
            .get_analysis(tid)
            .ok()
            .flatten()
            .and_then(|a| a.replaygain_db);
        Some((tid, path, t.total_time_ms.unwrap_or(0) as u64, gain_db))
    });

    let player = app.state::<Mutex<AudioPlayer>>();
    if let Ok(mut p) = player.lock() {
        p.set_volume(saved.volume);
        p.restore_queue(
            saved.queue.clone(),
            saved.order.clone(),
            saved.order_pos,
            saved.shuffle,
            saved.repeat,
        );
        if let Some((tid, path, duration, gain_db)) = track {
            // ファイル欠損・デバイス無しなどで読めなくてもキューの復元は活かす。
            if let Err(e) = p.load_paused(&path, tid, duration, gain_db, saved.position_ms) {
                crate::logging::write_line("warn", &format!("playback restore: {}", e));
            }
        }
    }
    app.state::<PlaybackPersister>()
        .restored
        .store(true, std::sync::atomic::Ordering::Relaxed);
}

/// 起動時に DB から再生状態を復元したか (フロントのマウント時同期の向きを決める)。
#[tauri::command]
pub fn get_playback_restored(persister: tauri::State<'_, PlaybackPersister>) -> bool {
    persister.restored()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::RepeatMode;

    fn snap() -> PlayerSnapshot {
        PlayerSnapshot {
            queue: vec![1, 2, 3],
            order: vec![0, 1, 2],
            order_pos: Some(1),
            track_id: Some(2),
            position_ms: 10_000,
            shuffle: false,
            repeat: RepeatMode::Off,
            volume: 0.8,
            preview: false,
        }
    }

    #[test]
    fn first_write_includes_queue() {
        let next = to_persisted(&snap(), false, None);
        assert_eq!(plan(&next, None, None, false), WritePlan::QueueAndState);
    }

    #[test]
    fn position_only_changes_are_throttled() {
        let last = to_persisted(&snap(), false, None);
        let mut s = snap();
        s.position_ms = 11_000;
        let next = to_persisted(&s, false, Some(&last));
        assert_eq!(
            plan(&next, Some(&last), Some(Duration::from_secs(1)), false),
            WritePlan::None
        );
        assert_eq!(
            plan(&next, Some(&last), Some(POSITION_INTERVAL), false),
            WritePlan::StateOnly
        );
        // 終了時は間引かない。
        assert_eq!(
            plan(&next, Some(&last), Some(Duration::from_secs(1)), true),
            WritePlan::StateOnly
        );
        // 変化が無ければ書かない。
        assert_eq!(plan(&last, Some(&last), None, true), WritePlan::None);
    }

    #[test]
    fn queue_and_state_changes_are_written_immediately() {
        let last = to_persisted(&snap(), false, None);
        let mut s = snap();
        s.order = vec![0, 2, 1];
        let next = to_persisted(&s, false, Some(&last));
        assert_eq!(
            plan(&next, Some(&last), Some(Duration::ZERO), false),
            WritePlan::QueueAndState
        );
        let mut s = snap();
        s.volume = 0.5;
        let next = to_persisted(&s, false, Some(&last));
        assert_eq!(
            plan(&next, Some(&last), Some(Duration::ZERO), false),
            WritePlan::StateOnly
        );
    }

    #[test]
    fn preview_keeps_last_real_track_and_position() {
        let last = to_persisted(&snap(), false, None);
        let mut s = snap();
        s.track_id = Some(99);
        s.position_ms = 3_000;
        s.preview = true;
        let next = to_persisted(&s, false, Some(&last));
        assert_eq!(next.track_id, Some(2));
        assert_eq!(next.position_ms, 10_000);
        assert_eq!(plan(&next, Some(&last), None, true), WritePlan::None);

        // バックエンドの preview フラグだけ立っている (曲終端後の停止中など) 場合も同様。
        let mut s = snap();
        s.track_id = None;
        let next = to_persisted(&s, true, Some(&last));
        assert_eq!(next.track_id, Some(2));
    }
}
