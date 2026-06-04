use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::{Duration, Instant};

use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::{Deserialize, Serialize};

use crate::models::PlaybackState;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    Off,
    All,
    One,
}

pub struct AudioPlayer {
    _stream: Option<OutputStream>,
    stream_handle: Option<OutputStreamHandle>,
    sink: Option<Sink>,
    current_track_id: Option<i64>,
    duration_ms: u64,
    play_started_at: Option<Instant>,
    accumulated_position_ms: u64,
    volume: f32,

    queue: Vec<i64>,
    /// 再生順 = `queue` のインデックスの並べ替え (shuffle 時はシャッフルされた並び)。
    order: Vec<usize>,
    /// `order` 上の現在位置 (Up Next はここ以降を表示する)。
    order_pos: Option<usize>,
    shuffle: bool,
    repeat: RepeatMode,
    /// `set_track_played` でフロントから「曲が終わった」と通知された後、
    /// `is_finished()` で次曲に進めるべきか判定するための sentinel。
    finished_for_advance: bool,
}

// OutputStream internally holds a cpal Stream which is !Send on some platforms
// but we guarantee single-threaded access via Mutex
unsafe impl Send for AudioPlayer {}
unsafe impl Sync for AudioPlayer {}

impl AudioPlayer {
    pub fn new() -> Self {
        let (stream, handle) = match OutputStream::try_default() {
            Ok((s, h)) => (Some(s), Some(h)),
            Err(_) => (None, None),
        };
        AudioPlayer {
            stream_handle: handle,
            _stream: stream,
            sink: None,
            current_track_id: None,
            duration_ms: 0,
            play_started_at: None,
            accumulated_position_ms: 0,
            volume: 1.0,

            queue: Vec::new(),
            order: Vec::new(),
            order_pos: None,
            shuffle: false,
            repeat: RepeatMode::Off,
            finished_for_advance: false,
        }
    }

    pub fn play(&mut self, file_path: &str, track_id: i64, duration_ms: u64) -> Result<(), String> {
        self.stop_internal();

        let handle = self
            .stream_handle
            .as_ref()
            .ok_or("No audio output available")?;

        let path = Path::new(file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }

        let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
        let reader = BufReader::new(file);
        let source = Decoder::new(reader).map_err(|e| format!("Failed to decode audio: {}", e))?;

        // Prefer the decoded source's reported duration when available.
        let actual_duration = source.total_duration().map(|d| d.as_millis() as u64);

        let sink = Sink::try_new(handle).map_err(|e| format!("Failed to create sink: {}", e))?;
        sink.set_volume(self.volume);
        sink.append(source);

        self.sink = Some(sink);
        self.current_track_id = Some(track_id);
        self.duration_ms = actual_duration.unwrap_or(duration_ms);
        self.play_started_at = Some(Instant::now());
        self.accumulated_position_ms = 0;
        self.finished_for_advance = false;

        Ok(())
    }

    pub fn pause(&mut self) {
        if let Some(ref sink) = self.sink {
            sink.pause();
            if let Some(started) = self.play_started_at.take() {
                self.accumulated_position_ms += started.elapsed().as_millis() as u64;
            }
        }
    }

    pub fn resume(&mut self) {
        if let Some(ref sink) = self.sink {
            sink.play();
            self.play_started_at = Some(Instant::now());
        }
    }

    pub fn stop(&mut self) {
        self.stop_internal();
    }

    fn stop_internal(&mut self) {
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
        self.current_track_id = None;
        self.duration_ms = 0;
        self.play_started_at = None;
        self.accumulated_position_ms = 0;
        self.finished_for_advance = false;
    }

    pub fn seek(&mut self, position_ms: u64) {
        if let Some(ref sink) = self.sink {
            // try_seek が成功したときだけ表示位置を更新する。
            // (一部フォーマットは seek 非対応で、実音はそのままなのに
            //  表示位置だけズレてしまうのを防ぐ)
            if sink.try_seek(Duration::from_millis(position_ms)).is_ok() {
                self.accumulated_position_ms = position_ms;
                if self.play_started_at.is_some() {
                    self.play_started_at = Some(Instant::now());
                }
            }
        }
    }

    pub fn set_volume(&mut self, v: f32) {
        let clamped = v.clamp(0.0, 1.0);
        self.volume = clamped;
        if let Some(ref sink) = self.sink {
            sink.set_volume(clamped);
        }
    }

    pub fn volume(&self) -> f32 {
        self.volume
    }

    pub fn is_playing(&self) -> bool {
        self.sink
            .as_ref()
            .is_some_and(|s| !s.is_paused() && !s.empty())
    }

    /// 現在の sink が完了しているか (キュー進行判定用)。
    pub fn is_finished(&mut self) -> bool {
        if let Some(ref sink) = self.sink {
            if sink.empty() && !self.finished_for_advance {
                self.finished_for_advance = true;
                return true;
            }
        }
        false
    }

    pub fn get_state(&self) -> PlaybackState {
        let position_ms = self.accumulated_position_ms
            + self
                .play_started_at
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);

        PlaybackState {
            is_playing: self.is_playing(),
            current_track_id: self.current_track_id,
            position_ms: position_ms.min(self.duration_ms.max(1)),
            duration_ms: self.duration_ms,
        }
    }

    // ===== Queue management =====

    pub fn set_queue(&mut self, track_ids: Vec<i64>, start_index: usize) {
        self.queue = track_ids;
        if self.queue.is_empty() {
            self.order.clear();
            self.order_pos = None;
            return;
        }
        let start = start_index.min(self.queue.len() - 1);
        self.rebuild_order(start);
    }

    /// `start` (queue index) を先頭にした再生順を作る。
    /// shuffle ON なら残りをシャッフル、OFF なら通常順。
    fn rebuild_order(&mut self, start: usize) {
        let n = self.queue.len();
        if self.shuffle {
            let mut rest: Vec<usize> = (0..n).filter(|&i| i != start).collect();
            shuffle_in_place(&mut rest);
            let mut order = Vec::with_capacity(n);
            order.push(start);
            order.extend(rest);
            self.order = order;
            self.order_pos = Some(0);
        } else {
            self.order = (0..n).collect();
            self.order_pos = Some(start);
        }
    }

    pub fn enqueue(&mut self, track_id: i64) {
        self.queue.push(track_id);
        self.order.push(self.queue.len() - 1);
        if self.order_pos.is_none() {
            self.order_pos = Some(self.order.len() - 1);
        }
    }

    pub fn clear_queue(&mut self) {
        self.queue.clear();
        self.order.clear();
        self.order_pos = None;
    }

    /// 再生順に並べた track_id 列 (Up Next 表示はこれを使う)。
    pub fn ordered_track_ids(&self) -> Vec<i64> {
        self.order
            .iter()
            .filter_map(|&i| self.queue.get(i).copied())
            .collect()
    }

    /// 再生順上の現在位置 (`ordered_track_ids` に対するインデックス)。
    pub fn order_pos(&self) -> Option<usize> {
        self.order_pos
    }

    pub fn set_shuffle(&mut self, on: bool) {
        if self.shuffle == on {
            return;
        }
        self.shuffle = on;
        if self.queue.is_empty() {
            return;
        }
        match self.order_pos {
            // ON: これから流す分 (現在位置より後) だけシャッフル。再生済みは保持。
            Some(pos) if on => {
                let tail_start = pos + 1;
                if tail_start < self.order.len() {
                    let mut tail: Vec<usize> = self.order[tail_start..].to_vec();
                    shuffle_in_place(&mut tail);
                    self.order.truncate(tail_start);
                    self.order.extend(tail);
                }
            }
            // OFF: 現在の曲を基準に通常順へ戻す。
            Some(pos) => {
                let cur = self.order.get(pos).copied().unwrap_or(0);
                self.order = (0..self.queue.len()).collect();
                self.order_pos = Some(cur);
            }
            None => {
                self.rebuild_order(0);
            }
        }
    }

    pub fn shuffle(&self) -> bool {
        self.shuffle
    }

    pub fn set_repeat(&mut self, mode: RepeatMode) {
        self.repeat = mode;
    }

    pub fn repeat(&self) -> RepeatMode {
        self.repeat
    }

    fn current_order_value(&self) -> Option<usize> {
        self.order_pos.and_then(|i| self.order.get(i).copied())
    }

    fn current_track_id_from_order(&self) -> Option<i64> {
        self.current_order_value()
            .and_then(|qi| self.queue.get(qi).copied())
    }

    /// 次に再生すべき track_id を返し、再生順の現在位置を進める。
    /// - repeat One: 現在の曲
    /// - 末尾 + repeat All: 先頭へ (shuffle 時は次の一巡を再シャッフル)
    /// - 末尾 + repeat Off: None
    ///
    /// `auto` は曲の自動終了による遷移かどうか。
    /// repeat=One は自動遷移のときだけ同じ曲を繰り返す
    /// (手動の「次へ」では One でも次の曲へ進む)。
    pub fn advance_next(&mut self, auto: bool) -> Option<i64> {
        if self.queue.is_empty() {
            return None;
        }
        if auto && matches!(self.repeat, RepeatMode::One) {
            return self.current_track_id_from_order();
        }
        match self.order_pos {
            Some(i) if i + 1 < self.order.len() => {
                self.order_pos = Some(i + 1);
            }
            Some(_) => {
                if !matches!(self.repeat, RepeatMode::All) {
                    return None;
                }
                if self.shuffle {
                    // 次の一巡を再シャッフル (直前の曲が先頭に来ないよう調整)。
                    let prev = self.current_order_value();
                    let mut all: Vec<usize> = (0..self.queue.len()).collect();
                    shuffle_in_place(&mut all);
                    if self.queue.len() > 1 {
                        if let Some(p) = prev {
                            if all[0] == p {
                                all.swap(0, 1);
                            }
                        }
                    }
                    self.order = all;
                }
                self.order_pos = Some(0);
            }
            None => {
                self.order_pos = Some(0);
            }
        }
        self.current_track_id_from_order()
    }

    pub fn advance_prev(&mut self) -> Option<i64> {
        if self.queue.is_empty() {
            return None;
        }
        match self.order_pos {
            Some(0) => {
                if matches!(self.repeat, RepeatMode::All) && !self.order.is_empty() {
                    self.order_pos = Some(self.order.len() - 1);
                } else {
                    self.order_pos = Some(0);
                }
            }
            Some(i) => {
                self.order_pos = Some(i - 1);
            }
            None => {
                self.order_pos = Some(0);
            }
        }
        self.current_track_id_from_order()
    }

    /// order 上の指定位置にジャンプし、その track_id を返す (再生は呼び出し側で行う)。
    /// Up Next からの選曲で、キュー順 (order_pos) を保ったまま頭出しするために使う。
    pub fn jump_to(&mut self, order_index: usize) -> Option<i64> {
        if order_index >= self.order.len() {
            return None;
        }
        self.order_pos = Some(order_index);
        self.current_track_id_from_order()
    }
}

/// Fisher-Yates シャッフル (`rand` 依存を増やさず軽量 PRNG で)。
fn shuffle_in_place(v: &mut [usize]) {
    let n = v.len();
    if n <= 1 {
        return;
    }
    let mut state = rng_seed();
    for i in (1..n).rev() {
        state = xorshift64(state);
        let j = (state % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}

fn rng_seed() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15);
    nanos | 1
}

fn xorshift64(mut x: u64) -> u64 {
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}
