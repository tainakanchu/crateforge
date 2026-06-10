use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::audio::{AudioPlayer, PlayReport, RepeatMode};
use crate::commands::library::open_db;
use crate::db::Database;
use crate::models::{PlaybackState, Track};

/// 再生実績 (`PlayReport`) を DB に反映する。
/// - 曲の半分以上 (上限 4 分) 聴いた → 「再生」(play_count +1, last_played 更新)
/// - 長さ不明なら 4 分以上で「再生」
/// - 4 秒以上だが途中で離脱 → 「スキップ」(skip_count +1)
/// - それ未満 → 誤操作とみなし無視
fn apply_report(db: &Database, report: Option<PlayReport>) {
    let Some(r) = report else {
        return;
    };
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

#[tauri::command]
pub fn play_track(
    app: AppHandle,
    track_id: i64,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    analyzer: tauri::State<'_, crate::analyzer::Analyzer>,
) -> Result<(), String> {
    let db = open_db(&app)?;
    let track = db
        .get_track_by_track_id(track_id)
        .map_err(|e| e.to_string())?
        .ok_or("Track not found")?;

    let path = track.location_path.as_deref().unwrap_or("");
    if path.is_empty() {
        return Err("No file path for this track".to_string());
    }

    let duration = track.total_time_ms.unwrap_or(0) as u64;
    let gain_db = db
        .get_analysis(track_id)
        .ok()
        .flatten()
        .and_then(|a| a.replaygain_db);
    let report = player
        .lock()
        .map_err(|e| e.to_string())?
        .play(path, track_id, duration, gain_db)?;
    apply_report(&db, report);

    db.add_recent_track(track_id).map_err(|e| e.to_string())?;
    // 再生した曲 = よく使う曲なので、未解析なら裏で解析しておく。
    analyzer.submit(vec![track_id], false);
    Ok(())
}

#[tauri::command]
pub fn pause(player: tauri::State<'_, Mutex<AudioPlayer>>) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.pause();
    Ok(())
}

#[tauri::command]
pub fn resume(player: tauri::State<'_, Mutex<AudioPlayer>>) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.resume();
    Ok(())
}

#[tauri::command]
pub fn stop(app: AppHandle, player: tauri::State<'_, Mutex<AudioPlayer>>) -> Result<(), String> {
    let report = player.lock().map_err(|e| e.to_string())?.stop();
    if let Ok(db) = open_db(&app) {
        apply_report(&db, report);
    }
    Ok(())
}

#[tauri::command]
pub fn seek(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    position_ms: u64,
) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.seek(position_ms);
    Ok(())
}

#[tauri::command]
pub fn get_playback_state(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<PlaybackState, String> {
    Ok(player.lock().map_err(|e| e.to_string())?.get_state())
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

#[tauri::command]
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
pub fn play_queue_at(
    app: AppHandle,
    order_index: usize,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<Option<i64>, String> {
    let tid = player
        .lock()
        .map_err(|e| e.to_string())?
        .jump_to(order_index);
    if let Some(tid) = tid {
        play_track_by_id(&app, tid)?;
        Ok(Some(tid))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn play_next(
    app: AppHandle,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<Option<i64>, String> {
    let next_id = player.lock().map_err(|e| e.to_string())?.advance_next(false);
    if let Some(tid) = next_id {
        play_track_by_id(&app, tid)?;
        Ok(Some(tid))
    } else {
        let report = player.lock().map_err(|e| e.to_string())?.stop();
        if let Ok(db) = open_db(&app) {
            apply_report(&db, report);
        }
        Ok(None)
    }
}

#[tauri::command]
pub fn play_prev(
    app: AppHandle,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<Option<i64>, String> {
    // iTunes 流儀: 3 秒以上再生していれば、前の曲ではなく現在の曲を頭から再生し直す。
    // (seek 非対応フォーマットでも確実に頭出しできるよう、シークではなく再生し直す)
    let restart = {
        let p = player.lock().map_err(|e| e.to_string())?;
        let st = p.get_state();
        if st.position_ms > 3000 {
            st.current_track_id
        } else {
            None
        }
    };
    if let Some(tid) = restart {
        play_track_by_id(&app, tid)?;
        return Ok(Some(tid));
    }
    let prev_id = player.lock().map_err(|e| e.to_string())?.advance_prev();
    if let Some(tid) = prev_id {
        play_track_by_id(&app, tid)?;
        Ok(Some(tid))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn set_shuffle(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    on: bool,
) -> Result<(), String> {
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

#[tauri::command]
pub fn set_volume(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
    volume: f32,
) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.set_volume(volume);
    Ok(())
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
/// デッドロック回避のため、ロックは「終了判定 → 次曲解決」の短いブロック内で完結させ、
/// 解放してから `play_track_by_id` (内部で再ロック) を呼ぶ。
pub fn advance_worker(app: AppHandle) {
    use tauri::Emitter;

    loop {
        std::thread::sleep(std::time::Duration::from_millis(100));

        // --- ロックを取り、終了判定と次曲解決をこのブロックで完結させる ---
        // (DB アクセス・再生はロック外で行うため、ここで結論だけ取り出す)
        let player = app.state::<Mutex<AudioPlayer>>();
        let next_id = {
            let mut guard = match player.lock() {
                Ok(g) => g,
                // ロックが poison しているなら他スレッドが panic 済み。次ループへ。
                Err(_) => continue,
            };
            if !guard.is_finished() {
                continue;
            }
            // 自動終了による遷移なので auto=true。
            guard.advance_next(true)
            // guard はここで drop され、ロックを解放する。
        };

        match next_id {
            Some(_) => {
                // 次曲を再生。ファイル欠損などで失敗したらさらに次へ進む
                // (無限ループ防止に、試行回数はキュー長を上限とする)。
                let played = play_with_skip_on_error(&app);
                let _ = app.emit("playback-advanced", AdvancePayload { track_id: played });
            }
            None => {
                // キュー末尾 + repeat off: 停止しつつ最後の曲を再生実績へ反映。
                let report = match player.lock() {
                    Ok(mut g) => g.stop(),
                    Err(_) => None,
                };
                if let Ok(db) = open_db(&app) {
                    apply_report(&db, report);
                }
                let _ = app.emit("playback-advanced", AdvancePayload { track_id: None });
            }
        }
    }
}

/// `playback-advanced` イベントの payload。`trackId` は再生開始した曲、
/// 停止した場合は null。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AdvancePayload {
    track_id: Option<i64>,
}

/// 直前に `advance_next` 済みの曲から順に再生を試み、失敗 (ファイル欠損など) したら
/// さらに次の曲へ進む。再生できた track_id を返す。全滅なら停止して None を返す。
///
/// 無限ループ防止のため、試行回数はその時点のキュー長を上限とする。
fn play_with_skip_on_error(app: &AppHandle) -> Option<i64> {
    let player = app.state::<Mutex<AudioPlayer>>();

    // その時点のキュー長を試行上限にする (repeat all で循環しても止まるように)、
    // と同時に呼び出し元で advance 済みの 1 曲目を取り出す。
    let (max_attempts, mut tid) = match player.lock() {
        Ok(g) => (g.queue_len().max(1), g.current_track_id_in_order()),
        Err(_) => return None,
    };

    for _ in 0..max_attempts {
        let Some(id) = tid else { break };
        if play_track_by_id(app, id).is_ok() {
            return Some(id);
        }
        // 失敗: 次の曲へ (auto=true で repeat を尊重)。
        tid = match player.lock() {
            Ok(mut g) => g.advance_next(true),
            Err(_) => return None,
        };
    }

    // 全滅: 停止する。
    if let Ok(mut g) = player.lock() {
        g.stop();
    }
    None
}

/// track_id の曲を実際に再生する。コマンドからもワーカースレッドからも呼べるよう、
/// `tauri::State` ではなく `&AppHandle` を受け取り、AudioPlayer の managed state は
/// 内部で `app.state` から取得する。
///
/// DB アクセス (トラック解決・解析取得) はロックの外で行い、`play` を呼ぶ瞬間だけ
/// 短時間ロックする。ワーカーとのデッドロックを避けるため、ロックを保持したまま
/// DB に触れない。
fn play_track_by_id(app: &AppHandle, track_id: i64) -> Result<(), String> {
    let db = open_db(app)?;
    let track = db
        .get_track_by_track_id(track_id)
        .map_err(|e| e.to_string())?
        .ok_or("Track not found")?;
    let path = track.location_path.as_deref().unwrap_or("");
    if path.is_empty() {
        return Err("No file path for this track".to_string());
    }
    let duration = track.total_time_ms.unwrap_or(0) as u64;
    let gain_db = db
        .get_analysis(track_id)
        .ok()
        .flatten()
        .and_then(|a| a.replaygain_db);
    let player = app.state::<Mutex<AudioPlayer>>();
    let report = player
        .lock()
        .map_err(|e| e.to_string())?
        .play(path, track_id, duration, gain_db)?;
    apply_report(&db, report);
    db.add_recent_track(track_id).map_err(|e| e.to_string())?;
    Ok(())
}
