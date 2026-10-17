use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::audio::{AudioPlayer, PlayReport, RepeatMode};
use crate::commands::library::open_db;
use crate::db::Database;
use crate::models::{PlaybackState, Track};
use crate::playback_target::PlaybackCoordinator;

/// Preview / Audition モード。ON の間は playCount / lastPlayed / recent を汚さない。
/// プロセス全体で共有するフラグ (Tauri managed state)。
pub struct PreviewMode(pub AtomicBool);

impl Default for PreviewMode {
    fn default() -> Self {
        Self(AtomicBool::new(false))
    }
}

impl PreviewMode {
    pub fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    pub fn set(&self, enabled: bool) {
        self.0.store(enabled, Ordering::Relaxed);
    }
}

fn preview_on(app: &AppHandle) -> bool {
    app.state::<PreviewMode>().get()
}

/// 再生操作の振り分け先 (Local / Cast)。中身は Arc なので clone して await を跨いで使う。
fn coordinator(app: &AppHandle) -> PlaybackCoordinator {
    app.state::<PlaybackCoordinator>().inner().clone()
}

/// 再生実績 (`PlayReport`) を DB に反映する。
/// - 曲の半分以上 (上限 4 分) 聴いた → 「再生」(play_count +1, last_played 更新)
/// - 長さ不明なら 4 分以上で「再生」
/// - 4 秒以上だが途中で離脱 → 「スキップ」(skip_count +1)
/// - それ未満 → 誤操作とみなし無視
/// - 再生開始時に preview だった曲 (`PlayReport.preview`) は一切反映しない
///   (フロントの「現在の preview フラグ」ではなくレポートに載った値で判断する)
pub(crate) fn apply_report(db: &Database, report: Option<PlayReport>) {
    let Some(r) = report else {
        return;
    };
    if r.preview {
        return;
    }
    let played_threshold = if r.duration_ms > 0 {
        (r.duration_ms / 2).min(240_000)
    } else {
        240_000
    };
    if r.played_ms >= played_threshold {
        let _ = db.mark_played(r.track_id);
    } else if r.played_ms >= 4_000 {
        let _ = db.mark_skipped(r.track_id);
    }
}

/// Cast 中は試聴 (Preview) を使えない (P0)。誤って Cast 先で試聴したりキューを
/// 壊したりしないよう、ON にする要求はエラーで断る。
#[tauri::command]
pub fn set_preview_mode(
    app: AppHandle,
    enabled: bool,
    preview: tauri::State<'_, PreviewMode>,
) -> Result<(), String> {
    if enabled && coordinator(&app).is_casting() {
        return Err(crate::cast::CastError::new(
            crate::cast::CastErrorCode::PreviewActive,
            "キャスト中は試聴 (Preview) を使えません",
        )
        .into());
    }
    preview.set(enabled);
    Ok(())
}

#[tauri::command]
pub fn get_preview_mode(preview: tauri::State<'_, PreviewMode>) -> Result<bool, String> {
    Ok(preview.get())
}

#[tauri::command]
pub async fn play_track(
    app: AppHandle,
    track_id: i64,
    analyzer: tauri::State<'_, crate::analyzer::Analyzer>,
) -> Result<(), String> {
    // 再生開始時の preview を曲と一緒に渡す。差し替えで返る report は「前の曲」の
    // 開始時フラグを持つので、現在フラグでは判断しない。
    let is_preview = preview_on(&app);
    coordinator(&app).play_track(track_id, is_preview).await?;
    // 再生した曲 = よく使う曲なので、未解析なら裏で解析しておく。
    analyzer.submit(vec![track_id], false);
    Ok(())
}

#[tauri::command]
pub async fn pause(app: AppHandle) -> Result<(), String> {
    Ok(coordinator(&app).pause().await?)
}

#[tauri::command]
pub async fn resume(app: AppHandle) -> Result<(), String> {
    Ok(coordinator(&app).resume().await?)
}

#[tauri::command]
pub async fn stop(app: AppHandle) -> Result<(), String> {
    Ok(coordinator(&app).stop().await?)
}

#[tauri::command]
pub async fn seek(app: AppHandle, position_ms: u64) -> Result<(), String> {
    Ok(coordinator(&app).seek(position_ms).await?)
}

/// 有効な再生先の再生状態 (Cast 中は Cast の位置 / 再生中 / 音量)。
#[tauri::command]
pub fn get_playback_state(app: AppHandle) -> Result<PlaybackState, String> {
    Ok(coordinator(&app).get_state())
}

#[tauri::command]
pub fn get_recent_tracks(app: AppHandle, limit: Option<i64>) -> Result<Vec<Track>, String> {
    let db = open_db(&app)?;
    db.get_recent_tracks(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

// ===== Queue / next / prev / shuffle / repeat / volume =====

#[tauri::command]
pub fn set_queue(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    track_ids: Vec<i64>,
    start_index: Option<usize>,
) -> Result<(), String> {
    player
        .lock()
        .map_err(|e| e.to_string())?
        .set_queue(track_ids, start_index.unwrap_or(0));
    Ok(())
}

#[tauri::command]
pub fn enqueue_track(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    track_id: i64,
) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.enqueue(track_id);
    Ok(())
}

/// 「次に再生」: 現在再生中の曲の直後に track_id を割り込ませる。
#[tauri::command]
pub fn enqueue_track_next(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    track_id: i64,
) -> Result<(), String> {
    player
        .lock()
        .map_err(|e| e.to_string())?
        .enqueue_next(track_id);
    Ok(())
}

/// Up Next (再生順) 上の指定位置の曲をキューから取り除く。
/// 再生中の曲 (現在位置) は取り除けず false を返す。
#[tauri::command]
pub fn remove_queue_at(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    order_index: usize,
) -> Result<bool, String> {
    Ok(player
        .lock()
        .map_err(|e| e.to_string())?
        .remove_at(order_index))
}

/// Up Next (再生順) 上の曲を並び替える。from・to とも現在位置より後ろのみ許可。
/// 不可な場合は false を返す。
#[tauri::command]
pub fn move_queue_item(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    from_order_index: usize,
    to_order_index: usize,
) -> Result<bool, String> {
    Ok(player
        .lock()
        .map_err(|e| e.to_string())?
        .move_order(from_order_index, to_order_index))
}

#[tauri::command]
pub fn clear_queue(player: tauri::State<'_, Mutex<AudioPlayer>>) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.clear_queue();
    Ok(())
}

/// ライブラリから消えた曲を再生系から落とす (キューから除去 / 再生中なら停止)。
/// 再生状態が変わったので `playback-advanced` を emit し、フロントの
/// プレイヤーバーと Up Next を即座に追従させる。
///
/// 停止時の `PlayReport` は捨てる: 対応する tracks 行はもう無く、
/// play_count / skip_count を書きに行っても行が無いため意味がない。
pub(crate) fn drop_tracks_from_playback(
    app: &AppHandle,
    player: &Mutex<AudioPlayer>,
    track_ids: &std::collections::HashSet<i64>,
) {
    use tauri::Emitter;

    let coord = coordinator(app);
    let casting = coord.is_casting();
    let stopped = match player.lock() {
        Ok(mut p) => {
            let hit_current = p.remove_tracks(track_ids);
            if hit_current && !casting {
                let _ = p.stop();
            }
            hit_current
        }
        Err(_) => false,
    };
    if stopped && casting {
        // Cast 先の停止は非同期。Receiver の応答を待たずに UI へは停止を知らせる。
        tauri::async_runtime::spawn(async move {
            let _ = coord.stop().await;
        });
    }
    let track_id = if stopped {
        None
    } else {
        player
            .lock()
            .ok()
            .and_then(|p| p.get_state().current_track_id)
    };
    let _ = app.emit("playback-advanced", AdvancePayload { track_id });
}

#[tauri::command(async)]
pub fn get_queue(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<crate::models::QueueState, String> {
    let p = player.lock().map_err(|e| e.to_string())?;
    Ok(crate::models::QueueState {
        track_ids: p.ordered_track_ids(),
        current_index: p.order_pos().map(|i| i as i64),
        shuffle: p.shuffle(),
        repeat: match p.repeat() {
            RepeatMode::Off => "off".to_string(),
            RepeatMode::All => "all".to_string(),
            RepeatMode::One => "one".to_string(),
        },
        volume: p.volume(),
    })
}

/// Up Next リストなどから、キュー順 (order) 上の指定位置にジャンプして再生する。
/// 再生順 (order_pos) を保つので、その後の自動遷移も Up Next の表示通りに進む。
#[tauri::command]
pub async fn play_queue_at(app: AppHandle, order_index: usize) -> Result<Option<i64>, String> {
    let tid = app
        .state::<Mutex<AudioPlayer>>()
        .lock()
        .map_err(|e| e.to_string())?
        .jump_to(order_index);
    if let Some(tid) = tid {
        play_track_by_id(&app, tid).await?;
        Ok(Some(tid))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn play_next(app: AppHandle) -> Result<Option<i64>, String> {
    next_track(&app).await
}

/// 手動の「次へ」(Tauri コマンドと Remote API で共有)。キュー末尾なら停止する。
pub(crate) async fn next_track(app: &AppHandle) -> Result<Option<i64>, String> {
    let next_id = app
        .state::<Mutex<AudioPlayer>>()
        .lock()
        .map_err(|e| e.to_string())?
        .advance_next(false);
    if let Some(tid) = next_id {
        play_track_by_id(app, tid).await?;
        Ok(Some(tid))
    } else {
        coordinator(app).stop().await?;
        Ok(None)
    }
}

#[tauri::command]
pub async fn play_prev(app: AppHandle) -> Result<Option<i64>, String> {
    // iTunes 流儀: 3 秒以上再生していれば、前の曲ではなく現在の曲を頭から再生し直す。
    // (seek 非対応フォーマットでも確実に頭出しできるよう、シークではなく再生し直す)
    // 位置は有効な再生先 (Cast 中は Cast) のものを使う。
    let restart = {
        let st = coordinator(&app).get_state();
        if st.position_ms > 3000 {
            st.current_track_id
        } else {
            None
        }
    };
    if let Some(tid) = restart {
        play_track_by_id(&app, tid).await?;
        return Ok(Some(tid));
    }
    let prev_id = app
        .state::<Mutex<AudioPlayer>>()
        .lock()
        .map_err(|e| e.to_string())?
        .advance_prev();
    if let Some(tid) = prev_id {
        play_track_by_id(&app, tid).await?;
        Ok(Some(tid))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn set_shuffle(player: tauri::State<'_, Mutex<AudioPlayer>>, on: bool) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.set_shuffle(on);
    Ok(())
}

#[tauri::command]
pub fn set_repeat(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    mode: String,
) -> Result<(), String> {
    let m = match mode.as_str() {
        "off" => RepeatMode::Off,
        "all" => RepeatMode::All,
        "one" => RepeatMode::One,
        other => return Err(format!("Unknown repeat mode: {}", other)),
    };
    player.lock().map_err(|e| e.to_string())?.set_repeat(m);
    Ok(())
}

/// 音量。Cast 中は Receiver の音量を変える (ローカルの音量とは独立)。
#[tauri::command]
pub async fn set_volume(app: AppHandle, volume: f32) -> Result<(), String> {
    Ok(coordinator(&app).set_volume(volume).await?)
}

#[tauri::command]
pub fn set_replaygain(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    enabled: bool,
) -> Result<(), String> {
    player
        .lock()
        .map_err(|e| e.to_string())?
        .set_replaygain(enabled);
    Ok(())
}

/// 曲の自動送りを駆動するバックグラウンドワーカー。
///
/// 従来はフロントが 500ms 間隔で `check_advance` をポーリングしていたが、WebView が
/// バックグラウンドでスロットルされると再生が止まる問題があった。これを Rust 側の
/// 専用スレッドに移し、WebView の状態に依存せず曲送りを続けられるようにする。
///
/// 100ms 間隔で `is_finished()` を確認し、終わっていたら次の曲へ進める。
/// 進行・停止のいずれの場合も Tauri イベント `playback-advanced`
/// (payload: `{ "trackId": number | null }`) を emit する。
///
/// Preview 中に曲が終端に達した場合はキューを進めず停止し、`preview-ended` を emit する。
/// プレビューは単曲試聴なので auto-advance せず、フロントが Esc と同じく元位置へ復帰する。
///
/// デッドロック回避のため、ロックは「終了判定 → 次曲解決」の短いブロック内で完結させ、
/// 解放してから `play_track_by_id` (内部で再ロック) を呼ぶ。
pub fn advance_worker(app: AppHandle) {
    use tauri::Emitter;

    loop {
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Cast 中の曲終了は Coordinator が MEDIA_STATUS から立てたフラグで知る。
        // (Cast 中の AudioPlayer は sink を持たないので is_finished() は立たない)
        let cast_finished = coordinator(&app).take_finished();

        // --- ロックを取り、終了判定と次曲解決をこのブロックで完結させる ---
        // (DB アクセス・再生はロック外で行うため、ここで結論だけ取り出す)
        let player = app.state::<Mutex<AudioPlayer>>();
        let decision = {
            let mut guard = match player.lock() {
                Ok(g) => g,
                // ロックが poison しているなら他スレッドが panic 済み。次ループへ。
                Err(_) => continue,
            };
            if !cast_finished && !guard.is_finished() {
                continue;
            }
            decide_advance(&mut guard, preview_on(&app))
            // guard はここで drop され、ロックを解放する。
        };

        match decision {
            AdvanceDecision::PreviewEnded { report } => {
                // バックエンド preview を落とし、統計は report.preview で判断。
                app.state::<PreviewMode>().set(false);
                if let Ok(db) = open_db(&app) {
                    apply_report(&db, report);
                }
                // フロントが exitPreview({ restore: true }) して元位置へ戻す。
                let _ = app.emit("preview-ended", ());
                let _ = app.emit("playback-advanced", AdvancePayload { track_id: None });
            }
            AdvanceDecision::PlayNext { .. } => {
                // 次曲を再生。ファイル欠損などで失敗したらさらに次へ進む
                // (無限ループ防止に、試行回数はキュー長を上限とする)。
                // このスレッドは tokio のワーカーではないので block_on してよい。
                let played = tauri::async_runtime::block_on(play_with_skip_on_error(&app));
                let _ = app.emit("playback-advanced", AdvancePayload { track_id: played });
            }
            AdvanceDecision::QueueEnded => {
                // キュー末尾 + repeat off: 停止しつつ最後の曲を再生実績へ反映
                // (Cast の実績は ItemEnded で反映済み)。
                let coord = coordinator(&app);
                let _ = tauri::async_runtime::block_on(coord.stop());
                let _ = app.emit("playback-advanced", AdvancePayload { track_id: None });
            }
        }
    }
}

/// 曲が終わったときの行動を決める (キュー位置はここで進める)。
fn decide_advance(player: &mut AudioPlayer, preview: bool) -> AdvanceDecision {
    // Preview 中はキューを進めず停止のみ。order_pos は触らない。
    if preview {
        return AdvanceDecision::PreviewEnded {
            report: player.stop(),
        };
    }
    // 自動終了による遷移なので auto=true。
    match player.advance_next(true) {
        Some(tid) => AdvanceDecision::PlayNext { _tid: tid },
        None => AdvanceDecision::QueueEnded,
    }
}

/// `advance_worker` が 1 ループで取る行動。
#[derive(Debug)]
enum AdvanceDecision {
    /// プレビュー曲が終端 → 停止のみ (キューは動かさない)。
    PreviewEnded { report: Option<PlayReport> },
    /// 通常の自動送り (advance_next 済み)。
    PlayNext { _tid: i64 },
    /// キュー末尾 + repeat off。
    QueueEnded,
}

/// `playback-advanced` イベントの payload。`trackId` は再生開始した曲、
/// 停止した場合は null。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdvancePayload {
    pub(crate) track_id: Option<i64>,
}

/// 直前に `advance_next` 済みの曲から順に再生を試み、失敗 (ファイル欠損など) したら
/// さらに次の曲へ進む。再生できた track_id を返す。全滅なら停止して None を返す。
///
/// 無限ループ防止のため、試行回数はその時点のキュー長を上限とする。
/// Cast の接続断など曲に依らない失敗では、キューを空回しせずにそこで止める。
async fn play_with_skip_on_error(app: &AppHandle) -> Option<i64> {
    let player = app.state::<Mutex<AudioPlayer>>();
    let coord = coordinator(app);

    // その時点のキュー長を試行上限にする (repeat all で循環しても止まるように)、
    // と同時に呼び出し元で advance 済みの 1 曲目を取り出す。
    let (max_attempts, mut tid) = match player.lock() {
        Ok(g) => (g.queue_len().max(1), g.current_track_id_in_order()),
        Err(_) => return None,
    };

    for _ in 0..max_attempts {
        let Some(id) = tid else { break };
        match coord.play_track(id, preview_on(app)).await {
            Ok(()) => return Some(id),
            Err(e) if !e.is_track_specific() => {
                crate::logging::write_line(
                    "warn",
                    &format!("auto-advance stopped: {}", String::from(e)),
                );
                return None;
            }
            Err(_) => {}
        }
        // 失敗: 次の曲へ (auto=true で repeat を尊重)。
        tid = match player.lock() {
            Ok(mut g) => g.advance_next(true),
            Err(_) => return None,
        };
    }

    // 全滅: 停止する。
    let _ = coord.stop().await;
    None
}

/// track_id の曲を有効な再生先で再生する (preview はバックエンドの現在フラグ)。
async fn play_track_by_id(app: &AppHandle, track_id: i64) -> Result<(), String> {
    Ok(coordinator(app)
        .play_track(track_id, preview_on(app))
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::PlayReport;
    use rusqlite::params;

    fn insert_track(db: &Database, track_id: i64) {
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, file_exists, play_count, skip_count)
                 VALUES (?1, 't', 1, 0, 0)",
                params![track_id],
            )
            .unwrap();
    }

    fn counts(db: &Database, track_id: i64) -> (i64, i64) {
        db.conn
            .query_row(
                "SELECT COALESCE(play_count, 0), COALESCE(skip_count, 0)
                 FROM tracks WHERE track_id = ?1",
                params![track_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    /// preview=true の PlayReport は play_count / skip_count を一切動かさない。
    #[test]
    fn apply_report_skips_stats_when_preview() {
        let db = Database::open_memory().unwrap();
        insert_track(&db, 1);
        apply_report(
            &db,
            Some(PlayReport {
                track_id: 1,
                played_ms: 120_000,
                duration_ms: 180_000,
                preview: true,
            }),
        );
        assert_eq!(counts(&db, 1), (0, 0));

        // スキップ閾値を超えていても preview なら無視。
        apply_report(
            &db,
            Some(PlayReport {
                track_id: 1,
                played_ms: 5_000,
                duration_ms: 180_000,
                preview: true,
            }),
        );
        assert_eq!(counts(&db, 1), (0, 0));
    }

    /// preview=false なら従来どおり再生 / スキップを計上する。
    #[test]
    fn apply_report_updates_stats_when_not_preview() {
        let db = Database::open_memory().unwrap();
        insert_track(&db, 10);
        insert_track(&db, 20);

        // 半分以上聴いた → mark_played
        apply_report(
            &db,
            Some(PlayReport {
                track_id: 10,
                played_ms: 120_000,
                duration_ms: 180_000,
                preview: false,
            }),
        );
        assert_eq!(counts(&db, 10), (1, 0));

        // 4 秒以上・半分未満 → mark_skipped
        apply_report(
            &db,
            Some(PlayReport {
                track_id: 20,
                played_ms: 5_000,
                duration_ms: 180_000,
                preview: false,
            }),
        );
        assert_eq!(counts(&db, 20), (0, 1));
    }
}

#[cfg(test)]
mod advance_tests {
    use super::*;

    fn casting_player(repeat: RepeatMode) -> AudioPlayer {
        let mut p = AudioPlayer::new();
        p.set_queue(vec![10, 20, 30], 2);
        p.set_repeat(repeat);
        // Cast で 3 曲目を再生中 (ローカルの sink は無い)。
        p.set_external_current(30, 1_000);
        p
    }

    /// Cast 中の AudioPlayer は sink を持たず、ローカルの終了判定で勝手に進まない。
    #[test]
    fn external_output_never_reports_finished() {
        let mut p = casting_player(RepeatMode::Off);
        assert!(!p.is_finished());
        assert_eq!(p.get_state().current_track_id, Some(30));
    }

    /// Cast の曲終了から先は従来と同じ repeat / キュー規則で次を決める。
    #[test]
    fn decide_advance_follows_repeat_rules() {
        let mut p = casting_player(RepeatMode::Off);
        assert!(matches!(
            decide_advance(&mut p, false),
            AdvanceDecision::QueueEnded
        ));

        let mut p = casting_player(RepeatMode::One);
        assert!(matches!(
            decide_advance(&mut p, false),
            AdvanceDecision::PlayNext { _tid: 30 }
        ));

        let mut p = casting_player(RepeatMode::All);
        assert!(matches!(
            decide_advance(&mut p, false),
            AdvanceDecision::PlayNext { _tid: 10 }
        ));
        assert_eq!(p.order_pos(), Some(0));
    }

    #[test]
    fn decide_advance_in_preview_keeps_queue_position() {
        let mut p = AudioPlayer::new();
        p.set_queue(vec![1, 2, 3], 0);
        assert!(matches!(
            decide_advance(&mut p, true),
            AdvanceDecision::PreviewEnded { .. }
        ));
        assert_eq!(p.order_pos(), Some(0));
    }
}
