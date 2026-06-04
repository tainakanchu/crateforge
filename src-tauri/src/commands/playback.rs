use std::sync::Mutex;

use tauri::AppHandle;

use crate::audio::{AudioPlayer, RepeatMode};
use crate::commands::library::open_db;
use crate::models::{PlaybackState, Track};

#[tauri::command]
pub fn play_track(
    app: AppHandle,
    track_id: i64,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
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
    player
        .lock()
        .map_err(|e| e.to_string())?
        .play(path, track_id, duration)?;

    db.add_recent_track(track_id).map_err(|e| e.to_string())?;
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
pub fn stop(player: tauri::State<'_, Mutex<AudioPlayer>>) -> Result<(), String> {
    player.lock().map_err(|e| e.to_string())?.stop();
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
        play_track_by_id(&app, &player, tid)?;
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
        play_track_by_id(&app, &player, tid)?;
        Ok(Some(tid))
    } else {
        player.lock().map_err(|e| e.to_string())?.stop();
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
        play_track_by_id(&app, &player, tid)?;
        return Ok(Some(tid));
    }
    let prev_id = player.lock().map_err(|e| e.to_string())?.advance_prev();
    if let Some(tid) = prev_id {
        play_track_by_id(&app, &player, tid)?;
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

/// フロントの polling から「曲が終わったので次に進めて」と呼ばれる。
/// is_finished で sentinel が立っていれば次の曲を再生し、track_id を返す。
#[tauri::command]
pub fn check_advance(
    app: AppHandle,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<Option<i64>, String> {
    let finished = player.lock().map_err(|e| e.to_string())?.is_finished();
    if !finished {
        return Ok(None);
    }
    let next_id = player.lock().map_err(|e| e.to_string())?.advance_next(true);
    if let Some(tid) = next_id {
        play_track_by_id(&app, &player, tid)?;
        Ok(Some(tid))
    } else {
        // キュー末尾 (repeat off) まで再生し終えた: 綺麗に停止状態へ。
        player.lock().map_err(|e| e.to_string())?.stop();
        Ok(None)
    }
}

fn play_track_by_id(
    app: &AppHandle,
    player: &tauri::State<'_, Mutex<AudioPlayer>>,
    track_id: i64,
) -> Result<(), String> {
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
    player
        .lock()
        .map_err(|e| e.to_string())?
        .play(path, track_id, duration)?;
    db.add_recent_track(track_id).map_err(|e| e.to_string())?;
    Ok(())
}
