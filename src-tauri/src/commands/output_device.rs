//! 出力デバイス選択 (#170) のコマンドと、起動時適用・抜去監視ワーカー。
//!
//! 選択は `app_state` の `output_device` キーに **デバイス名** で保存する
//! (空文字 / 未設定 = システム既定)。cpal のデバイス ID は環境によって安定しないため。
//!
//! - 起動時 (`apply_saved`): 再生状態の復元 (#159) より前に保存済みデバイスを開く。
//!   見つからなければシステム既定のまま続行し、フロントへ通知を積む (希望は保持)。
//! - 再生中の抜去 (`watch_worker`): cpal のエラーコールバックがデバイス喪失を検知したら、
//!   希望のデバイスがまだ見えていればそれを、無ければシステム既定を開き直す。
//!   曲・位置・再生/一時停止は `AudioPlayer::replace_output` が引き継ぐ。
//! - 「システム既定」選択中は OS の既定出力の変更を定期的に確認して追従する。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::output::{self, DeviceChoice, OpenedSink, OutputDeviceInfo};
use crate::audio::AudioPlayer;
use crate::commands::library::open_db;

/// `app_state` のキー。
const STATE_KEY: &str = "output_device";
/// フロントへ「通知が積まれた」ことを知らせるイベント名。
const NOTICE_EVENT: &str = "output-device-notice";
/// 抜去監視の間隔。
const WATCH_TICK: Duration = Duration::from_millis(500);
/// 「システム既定」追従のために OS 既定デバイスを確認する間隔。
const DEFAULT_POLL: Duration = Duration::from_secs(3);

/// フロントへ出す非ブロッキング通知。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDeviceNotice {
    /// `missing`: 起動時に保存済みデバイスが無かった / `lost`: 再生中に抜かれた。
    pub kind: &'static str,
    /// 希望していたデバイス名 (システム既定なら None)。
    pub device: Option<String>,
    /// 代わりに開いたデバイス名 (分からなければ None、開けなければ None)。
    pub active: Option<String>,
}

/// 未読の通知 (Tauri managed state)。起動直後はフロントがまだ listen していないので
/// イベントだけでなくここにも積み、フロントはマウント時とイベント受信時に取り出す。
#[derive(Default)]
pub struct OutputDeviceNotices(Mutex<Vec<OutputDeviceNotice>>);

fn push_notice(app: &AppHandle, notice: OutputDeviceNotice) {
    if let Ok(mut v) = app.state::<OutputDeviceNotices>().0.lock() {
        v.push(notice);
    }
    let _ = app.emit(NOTICE_EVENT, ());
}

/// Settings の選択肢用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevicesState {
    pub devices: Vec<OutputDeviceInfo>,
    /// ユーザーの選択 (None = システム既定)。
    pub selected: Option<String>,
    /// 実際に鳴っているデバイス。
    pub active: Option<String>,
}

fn normalize(name: Option<String>) -> Option<String> {
    name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty())
}

fn persist(app: &AppHandle, name: Option<&str>) {
    match open_db(app) {
        Ok(db) => {
            if let Err(e) = db.set_state(STATE_KEY, name.unwrap_or("")) {
                crate::logging::write_line("warn", &format!("output device persist: {}", e));
            }
        }
        Err(e) => crate::logging::write_line("warn", &format!("output device persist: {}", e)),
    }
}

/// 出力デバイス一覧と現在の選択を返す。デバイスが 1 つも無くても空一覧で成功する。
#[tauri::command]
pub fn list_output_devices(
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<OutputDevicesState, String> {
    // 列挙はバックエンドによって遅いことがあるのでロックの外で行う。
    let devices = output::list_output_devices();
    let p = player.lock().map_err(|e| e.to_string())?;
    Ok(OutputDevicesState {
        devices,
        selected: p.output_device().map(str::to_string),
        active: p.active_device().map(str::to_string),
    })
}

/// 出力デバイスを切り替える (`name` = None / 空 でシステム既定)。
/// 再生中の曲・位置・一時停止状態・キュー・音量・ReplayGain は保ったまま開き直す。
/// 指定デバイスが開けなければ Err を返し、現在の出力と保存値は変えない。
#[tauri::command]
pub fn set_output_device(
    app: AppHandle,
    name: Option<String>,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<Option<String>, String> {
    let requested = normalize(name);
    let opened = match requested.as_deref() {
        Some(n) => output::open_named(n)?,
        None => output::open_default()?,
    };
    // 一覧上の正式名で保存する (大文字小文字の揺れで一致した場合など)。
    let requested = requested.map(|r| opened.name.clone().unwrap_or(r));
    let active = {
        let mut p = player.lock().map_err(|e| e.to_string())?;
        p.replace_output(opened, requested.clone());
        p.active_device().map(str::to_string)
    };
    persist(&app, requested.as_deref());
    Ok(active)
}

/// 未読の通知を取り出す (取り出した分は消える)。
#[tauri::command]
pub fn take_output_device_notices(
    notices: tauri::State<'_, OutputDeviceNotices>,
) -> Vec<OutputDeviceNotice> {
    notices
        .0
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default()
}

/// 起動時: 保存済みの出力デバイスを開く。`playback_persist::restore` より前に呼ぶ。
pub fn apply_saved(app: &AppHandle) {
    let saved = open_db(app)
        .ok()
        .and_then(|db| db.get_state(STATE_KEY).ok().flatten());
    let saved = normalize(saved);
    if saved.is_none() {
        return; // システム既定 (AudioPlayer::new で開き済み)。
    }
    let available: Vec<String> = output::list_output_devices()
        .into_iter()
        .map(|d| d.name)
        .collect();
    let player = app.state::<Mutex<AudioPlayer>>();
    match output::resolve_choice(saved.as_deref(), &available) {
        DeviceChoice::SystemDefault => {}
        DeviceChoice::Named(name) => match output::open_named(&name) {
            Ok(opened) => {
                if let Ok(mut p) = player.lock() {
                    p.replace_output(opened, Some(name));
                }
            }
            Err(e) => {
                crate::logging::write_line("warn", &format!("output device: {}", e));
                fallback_notice(app, &player, saved, "missing");
            }
        },
        DeviceChoice::Missing(_) => {
            crate::logging::write_line(
                "warn",
                &format!("output device not found, using system default: {:?}", saved),
            );
            fallback_notice(app, &player, saved, "missing");
        }
    }
}

/// 既定出力のまま、希望 (`saved`) は保持して通知を積む。
fn fallback_notice(
    app: &AppHandle,
    player: &Mutex<AudioPlayer>,
    saved: Option<String>,
    kind: &'static str,
) {
    let active = player.lock().ok().and_then(|mut p| {
        p.set_output_preference(saved.clone());
        p.active_device().map(str::to_string)
    });
    push_notice(
        app,
        OutputDeviceNotice {
            kind,
            device: saved,
            active,
        },
    );
}

/// 希望のデバイス (見えていれば) → システム既定 の順に開く。
fn reopen(requested: Option<&str>) -> Result<OpenedSink, String> {
    if let Some(name) = requested {
        if let Ok(o) = output::open_named(name) {
            return Ok(o);
        }
    }
    output::open_default()
}

/// 抜去監視ワーカー。cpal のエラーコールバックが立てたフラグを見て出力を開き直す。
/// また「システム既定」選択中は OS 既定デバイスの変更に追従する。
pub fn watch_worker(app: AppHandle) {
    let mut pending_retry = false;
    let mut logged_failure = false;
    let mut last_default_poll = Instant::now();
    loop {
        std::thread::sleep(WATCH_TICK);
        let player = app.state::<Mutex<AudioPlayer>>();
        let (lost, requested, active) = match player.lock() {
            Ok(p) => (
                p.take_device_lost(),
                p.output_device().map(str::to_string),
                p.active_device().map(str::to_string),
            ),
            Err(_) => continue,
        };

        let mut need_reopen = lost || pending_retry;
        let mut reason: Option<&'static str> = lost.then_some("lost");
        if !need_reopen && requested.is_none() && last_default_poll.elapsed() >= DEFAULT_POLL {
            last_default_poll = Instant::now();
            // 既定デバイス名が取れていて、いま開いているものと違えば追従する。
            // (active が None = 名前不明のフォールバックで開いた場合は比較できないので何もしない)
            if let (Some(def), Some(act)) = (output::list_default_name(), active.as_deref()) {
                if def != act {
                    need_reopen = true;
                    reason = None;
                }
            }
        }
        if !need_reopen {
            continue;
        }

        match reopen(requested.as_deref()) {
            Ok(opened) => {
                pending_retry = false;
                logged_failure = false;
                let new_active = opened.name.clone();
                if let Ok(mut p) = player.lock() {
                    p.replace_output(opened, requested.clone());
                }
                crate::logging::write_line(
                    "info",
                    &format!("audio output reopened: {:?}", new_active),
                );
                // 希望のデバイス以外 (= 既定) にフォールバックしたときだけ知らせる。
                if reason.is_some() && requested.is_some() && new_active != requested {
                    push_notice(
                        &app,
                        OutputDeviceNotice {
                            kind: "lost",
                            device: requested,
                            active: new_active,
                        },
                    );
                }
            }
            Err(e) => {
                // 開けるデバイスが無い。次の tick で再試行する (ログは 1 回だけ)。
                pending_retry = true;
                if !logged_failure {
                    logged_failure = true;
                    crate::logging::write_line(
                        "warn",
                        &format!("audio output reopen failed: {}", e),
                    );
                }
            }
        }
    }
}
