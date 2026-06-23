use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::{Duration, Instant};

use rodio::stream::MixerDeviceSink;
use rodio::{Decoder, DeviceSinkBuilder, Player, Source};
use serde::{Deserialize, Serialize};

use crate::models::PlaybackState;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    Off,
    All,
    One,
}

/// 「いま終わった (停止/差し替えられた) 曲」の再生実績の要約。
/// コマンド層がこれを見て play_count / skip_count を更新する。
#[derive(Debug, Clone, Copy)]
pub struct PlayReport {
    pub track_id: i64,
    /// 実際に聴いていた長さ (ms、durationを超えない)。
    pub played_ms: u64,
    /// その曲の長さ (ms、不明なら 0)。
    pub duration_ms: u64,
}

pub struct AudioPlayer {
    /// 既定の出力デバイス (cpal Stream を内包)。drop すると再生が止まるので保持する。
    /// rodio 0.22 では `OutputStream` + `OutputStreamHandle` の 2 つではなく、
    /// `MixerDeviceSink` 1 つから `mixer()` を取り出して `Player` を都度生成する。
    _device: Option<MixerDeviceSink>,
    sink: Option<Player>,
    current_track_id: Option<i64>,
    duration_ms: u64,
    play_started_at: Option<Instant>,
    accumulated_position_ms: u64,
    volume: f32,
    /// ReplayGain (音量正規化) を適用するか。
    replaygain_enabled: bool,
    /// いま再生中の曲の ReplayGain ゲイン (dB)。None なら未知。
    current_gain_db: Option<f64>,

    // ===== キューの不変条件 (queue / order / order_pos は常にこれを満たす) =====
    // - `order` は `0..queue.len()` の順列 (各 queue インデックスがちょうど 1 回ずつ現れる)。
    // - `order_pos` は `order` へのインデックス (`Some(i)` なら `i < order.len()`)。
    //   queue が空のときのみ `None`。
    // これらを壊すと ordered_track_ids / advance_* が破綻するため、
    // キューを変更する全メソッドはこの不変条件を維持しなければならない。
    queue: Vec<i64>,
    /// 再生順 = `queue` のインデックスの並べ替え (shuffle 時はシャッフルされた並び)。
    /// 常に `0..queue.len()` の順列。
    order: Vec<usize>,
    /// `order` 上の現在位置 (Up Next はここ以降を表示する)。`order` へのインデックス。
    order_pos: Option<usize>,
    shuffle: bool,
    repeat: RepeatMode,
    /// `set_track_played` でフロントから「曲が終わった」と通知された後、
    /// `is_finished()` で次曲に進めるべきか判定するための sentinel。
    finished_for_advance: bool,
}

// MixerDeviceSink internally holds a cpal Stream which is !Send on some platforms
// but we guarantee single-threaded access via Mutex
unsafe impl Send for AudioPlayer {}
unsafe impl Sync for AudioPlayer {}

impl AudioPlayer {
    pub fn new() -> Self {
        // デバイスが無ければ None で継続 (再生不可だがアプリは動く)。
        let device = match DeviceSinkBuilder::open_default_sink() {
            Ok(mut d) => {
                // drop 時に stderr へ "Dropping DeviceSink..." を吐くのを抑止する。
                d.log_on_drop(false);
                Some(d)
            }
            Err(_) => None,
        };
        AudioPlayer {
            _device: device,
            sink: None,
            current_track_id: None,
            duration_ms: 0,
            play_started_at: None,
            accumulated_position_ms: 0,
            volume: 1.0,
            replaygain_enabled: false,
            current_gain_db: None,

            queue: Vec::new(),
            order: Vec::new(),
            order_pos: None,
            shuffle: false,
            repeat: RepeatMode::Off,
            finished_for_advance: false,
        }
    }

    /// 新しい曲を再生する。差し替え前に再生していた曲があれば、その実績を
    /// `PlayReport` として返す (コマンド層が play/skip カウントに反映する)。
    pub fn play(
        &mut self,
        file_path: &str,
        track_id: i64,
        duration_ms: u64,
        gain_db: Option<f64>,
    ) -> Result<Option<PlayReport>, String> {
        let report = self.stop_internal();

        let device = self
            ._device
            .as_ref()
            .ok_or("No audio output available")?;

        let path = Path::new(file_path);
        if !path.exists() {
            // どの曲が何で再生失敗したかを crateforge.log に残す (#67)。
            crate::logging::write_line(
                "error",
                &format!("playback failed: file not found ({})", file_path),
            );
            return Err(format!("File not found: {}", file_path));
        }

        self.current_gain_db = gain_db;
        let volume = self.effective_volume();

        // デコード (rodio → symphonia) は壊れた / エッジケースなファイルで内部 panic する
        // ことがある。これは Result::Err ではなく panic なので map_err では捕まらない。
        // catch_unwind で囲い、アプリごと abort させず「その曲だけ再生失敗」に留める。
        // (panic フック=logging は unwind 中に走るので crateforge.log には残り原因追跡できる。)
        let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
            // byte_len は seek / duration 算出に必要なので metadata から取得する
            // (取れなくてもデコード自体は可能。その場合は seek/duration の精度が落ちるだけ)。
            let byte_len = file.metadata().ok().map(|m| m.len());
            let reader = BufReader::new(file);
            // rodio 0.22 の Decoder ビルダ。`with_gapless(false)` が肝:
            // gapless 初期化中の seek が一部 MP4 で Error::SeekError を返すと、
            // rodio の SymphoniaDecoder::new が `unreachable!("Seek errors should not
            // occur during initialization")` で panic する (rodio 0.20→0.22 で
            // この unreachable! 自体は残っているが、0.22 では gapless が設定可能になった)。
            // gapless を切ればその初期化 seek を踏まないので当該 panic を回避できる。
            // トレードオフ: gapless off では AAC/MP3 のエンコーダ遅延/パディングの
            // トリミングが効かず、曲頭にごく短い無音(~数十ms)が入りうる。曲またぎの
            // gapless 再生はこのプレイヤー(曲ごとに source 再生成)では使っていないため
            // 影響は軽微で、クラッシュ回避を優先する。
            let mut builder = Decoder::builder().with_data(reader).with_gapless(false);
            if let Some(len) = byte_len {
                builder = builder.with_byte_len(len);
            }
            let source = builder
                .build()
                .map_err(|e| format!("Failed to decode audio: {}", e))?;
            // Prefer the decoded source's reported duration when available.
            let actual_duration = source.total_duration().map(|d| d.as_millis() as u64);
            let sink = Player::connect_new(device.mixer());
            sink.set_volume(volume);
            sink.append(source);
            Ok::<(Player, Option<u64>), String>((sink, actual_duration))
        }));
        let (sink, actual_duration) = match built {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                // デコード/ファイルオープン失敗。どの曲が何で失敗したかを残す (#67)。
                crate::logging::write_line(
                    "error",
                    &format!("playback failed: {} ({})", e, file_path),
                );
                return Err(e);
            }
            // デコーダ等が panic した場合: その曲だけ失敗扱いにしてアプリは継続。
            // panic 本体は panic フックが既に記録済みなので、ここでは曲のパスを補足する (#67)。
            Err(_) => {
                crate::logging::write_line(
                    "error",
                    &format!("playback failed: decoder crashed ({})", file_path),
                );
                return Err(format!("Failed to play (decoder crashed): {}", file_path));
            }
        };

        self.sink = Some(sink);
        self.current_track_id = Some(track_id);
        self.duration_ms = actual_duration.unwrap_or(duration_ms);
        self.play_started_at = Some(Instant::now());
        self.accumulated_position_ms = 0;
        self.finished_for_advance = false;

        Ok(report)
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

    /// 明示停止。停止した曲の再生実績を返す。
    pub fn stop(&mut self) -> Option<PlayReport> {
        self.stop_internal()
    }

    /// 現在の sink を止めて状態をクリアし、停止直前まで再生していた曲の
    /// 実績 (`PlayReport`) を返す。再生していなければ None。
    fn stop_internal(&mut self) -> Option<PlayReport> {
        let report = self.current_track_id.map(|tid| {
            let played = self.accumulated_position_ms
                + self
                    .play_started_at
                    .map(|t| t.elapsed().as_millis() as u64)
                    .unwrap_or(0);
            let played = if self.duration_ms > 0 {
                played.min(self.duration_ms)
            } else {
                played
            };
            PlayReport {
                track_id: tid,
                played_ms: played,
                duration_ms: self.duration_ms,
            }
        });
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
        self.current_track_id = None;
        self.duration_ms = 0;
        self.play_started_at = None;
        self.accumulated_position_ms = 0;
        self.finished_for_advance = false;
        report
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
        self.volume = v.clamp(0.0, 1.0);
        if let Some(ref sink) = self.sink {
            sink.set_volume(self.effective_volume());
        }
    }

    pub fn volume(&self) -> f32 {
        self.volume
    }

    /// ReplayGain の ON/OFF を切り替え、再生中なら即座に音量へ反映する。
    pub fn set_replaygain(&mut self, enabled: bool) {
        self.replaygain_enabled = enabled;
        if let Some(ref sink) = self.sink {
            sink.set_volume(self.effective_volume());
        }
    }

    /// ユーザー音量 × (ReplayGain 有効時のみ) トラックゲイン。0..1 にクランプ。
    fn effective_volume(&self) -> f32 {
        let gain = if self.replaygain_enabled {
            self.current_gain_db.map(db_to_linear).unwrap_or(1.0)
        } else {
            1.0
        };
        (self.volume * gain).clamp(0.0, 1.0)
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

    /// 「次に再生」: track_id を queue 末尾に積み、その queue インデックスを
    /// `order` 上の現在位置の直後 (`order_pos + 1`) に挿入する。
    /// `order_pos` が None (まだ何も再生していない) の場合は `enqueue` と同じく末尾に追加する。
    ///
    /// 不変条件は維持される: 新しい queue インデックスはちょうど 1 個増え、
    /// それを order に 1 回だけ挿入するので order は引き続き順列。
    /// 挿入位置は order_pos より後ろなので order_pos の指す要素は変わらない。
    pub fn enqueue_next(&mut self, track_id: i64) {
        self.queue.push(track_id);
        let qi = self.queue.len() - 1;
        match self.order_pos {
            Some(pos) => {
                // 現在位置の直後 (末尾を超える場合は push 相当) に挿入。
                let insert_at = (pos + 1).min(self.order.len());
                self.order.insert(insert_at, qi);
            }
            None => {
                self.order.push(qi);
                self.order_pos = Some(self.order.len() - 1);
            }
        }
    }

    /// `order` 上の指定位置の曲をキューから除去する。除去できたら true。
    /// - `order_index == order_pos` (再生中の曲) は拒否して false を返す。
    /// - `order_index` が範囲外でも false。
    ///
    /// queue から該当要素を取り除き、`order` 内に残る「除去した queue インデックスより
    /// 大きい値」を 1 ずつ詰める (queue の Vec が縮むため)。order エントリ自体も除去し、
    /// 除去位置が現在位置より前なら `order_pos` を 1 つ前へずらす。
    /// これにより不変条件 (order は `0..queue.len()` の順列) が保たれる。
    pub fn remove_at(&mut self, order_index: usize) -> bool {
        if order_index >= self.order.len() {
            return false;
        }
        if self.order_pos == Some(order_index) {
            return false;
        }
        // 除去対象の queue インデックス。
        let qi = self.order[order_index];

        // queue から実体を除去。
        self.queue.remove(qi);

        // order エントリを除去。
        self.order.remove(order_index);

        // 縮んだ queue に合わせて、qi より大きいインデックスを 1 ずつ詰める。
        for v in self.order.iter_mut() {
            if *v > qi {
                *v -= 1;
            }
        }

        // 除去位置が現在位置より前なら order_pos を 1 つ前へ。
        if let Some(pos) = self.order_pos {
            if order_index < pos {
                self.order_pos = Some(pos - 1);
            }
        }
        // queue が空になったら状態をクリア。
        if self.queue.is_empty() {
            self.order_pos = None;
        }
        true
    }

    /// `order` 上の `from` の要素を `to` へ移動する (Up Next の並び替え用)。
    /// 移動できたら true。`from`・`to` とも現在位置 (`order_pos`) より後ろの位置のみ許可し、
    /// それ以外 (現在位置以前・範囲外) は false を返す。
    ///
    /// order の要素を入れ替えるだけなので順列性は保たれ、order_pos は動かさない。
    pub fn move_order(&mut self, from: usize, to: usize) -> bool {
        let len = self.order.len();
        if from >= len || to >= len {
            return false;
        }
        // order_pos より後ろ (Up Next の範囲) のみ許可。再生済み・再生中は不可。
        let min_allowed = match self.order_pos {
            Some(pos) => pos + 1,
            None => 0,
        };
        if from < min_allowed || to < min_allowed {
            return false;
        }
        if from == to {
            return true;
        }
        let v = self.order.remove(from);
        self.order.insert(to, v);
        true
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

    /// キューに積まれている曲数。
    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }

    /// `order_pos` が指している現在の track_id (再生順ベース)。
    /// ワーカーが advance 後の曲を再生するために使う。
    pub fn current_track_id_in_order(&self) -> Option<i64> {
        self.current_track_id_from_order()
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

/// dB ゲインを線形倍率へ。
fn db_to_linear(db: f64) -> f32 {
    10f32.powf((db as f32) / 20.0)
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

#[cfg(test)]
mod tests {
    use super::*;

    // 再生はせずキューロジックのみ検証する。`AudioPlayer::new()` はオーディオデバイスが
    // 無くても stream/sink が None になるだけで、queue/order/order_pos の操作には影響しない。

    /// order が `0..queue.len()` の順列であることを検証する (不変条件)。
    fn assert_order_is_permutation(p: &AudioPlayer) {
        let n = p.queue.len();
        assert_eq!(p.order.len(), n, "order の長さは queue 長と一致するはず");
        let mut seen = vec![false; n];
        for &qi in &p.order {
            assert!(qi < n, "order の値 {} が範囲外 (queue len {})", qi, n);
            assert!(!seen[qi], "order の値 {} が重複している", qi);
            seen[qi] = true;
        }
        // order_pos は order へのインデックス。
        if let Some(pos) = p.order_pos {
            assert!(pos < n.max(1), "order_pos {} が範囲外", pos);
        }
        if n == 0 {
            assert_eq!(p.order_pos, None, "空キューでは order_pos は None");
        }
    }

    fn make_player(ids: Vec<i64>, start: usize) -> AudioPlayer {
        let mut p = AudioPlayer::new();
        p.set_queue(ids, start);
        p
    }

    #[test]
    fn set_queue_initial_state() {
        let p = make_player(vec![10, 20, 30], 1);
        assert_eq!(p.order, vec![0, 1, 2]);
        assert_eq!(p.order_pos, Some(1));
        assert_eq!(p.current_track_id_from_order(), Some(20));
        assert_order_is_permutation(&p);
    }

    #[test]
    fn advance_next_repeat_off_stops_at_end() {
        let mut p = make_player(vec![10, 20, 30], 0);
        assert_eq!(p.advance_next(true), Some(20));
        assert_eq!(p.advance_next(true), Some(30));
        // 末尾 + repeat off → None。
        assert_eq!(p.advance_next(true), None);
    }

    #[test]
    fn advance_next_repeat_all_wraps() {
        let mut p = make_player(vec![10, 20, 30], 2);
        p.set_repeat(RepeatMode::All);
        // 末尾 → 先頭へ折り返す。
        assert_eq!(p.advance_next(true), Some(10));
        assert_eq!(p.order_pos, Some(0));
        assert_order_is_permutation(&p);
    }

    #[test]
    fn advance_next_repeat_one_auto_vs_manual() {
        let mut p = make_player(vec![10, 20, 30], 0);
        p.set_repeat(RepeatMode::One);
        // auto=true は同じ曲を繰り返す。
        assert_eq!(p.advance_next(true), Some(10));
        assert_eq!(p.order_pos, Some(0));
        // auto=false (手動「次へ」) は One でも次の曲へ。
        assert_eq!(p.advance_next(false), Some(20));
        assert_eq!(p.order_pos, Some(1));
    }

    #[test]
    fn shuffle_toggle_keeps_permutation() {
        let mut p = make_player(vec![1, 2, 3, 4, 5], 0);
        p.set_shuffle(true);
        assert!(p.shuffle());
        assert_order_is_permutation(&p);
        // 現在の曲 (order_pos=0 の指す曲) は保持される。
        assert_eq!(p.current_track_id_from_order(), Some(1));

        p.set_shuffle(false);
        assert!(!p.shuffle());
        assert_eq!(p.order, vec![0, 1, 2, 3, 4]);
        assert_order_is_permutation(&p);
    }

    #[test]
    fn enqueue_next_inserts_after_current() {
        let mut p = make_player(vec![10, 20, 30], 0);
        // order_pos=0 (曲 10 再生中) の直後に 99 を割り込ませる。
        p.enqueue_next(99);
        assert_order_is_permutation(&p);
        let ordered = p.ordered_track_ids();
        assert_eq!(ordered, vec![10, 99, 20, 30]);
        // 現在位置は動かない。
        assert_eq!(p.order_pos, Some(0));
        assert_eq!(p.current_track_id_from_order(), Some(10));
        // 次に進むと割り込んだ曲が来る。
        assert_eq!(p.advance_next(true), Some(99));
    }

    #[test]
    fn enqueue_next_when_no_position_appends() {
        let mut p = AudioPlayer::new();
        // 空状態から enqueue_next → enqueue と同じく末尾追加・order_pos が立つ。
        p.enqueue_next(42);
        assert_eq!(p.queue, vec![42]);
        assert_eq!(p.order_pos, Some(0));
        assert_order_is_permutation(&p);
    }

    #[test]
    fn enqueue_next_with_shuffle_inserts_after_current() {
        let mut p = make_player(vec![1, 2, 3, 4, 5], 0);
        p.set_shuffle(true);
        let pos = p.order_pos.unwrap();
        p.enqueue_next(99);
        assert_order_is_permutation(&p);
        // シャッフル中でも、割り込んだ曲は現在位置の直後に来る。
        let ordered = p.ordered_track_ids();
        assert_eq!(ordered[pos + 1], 99);
    }

    #[test]
    fn remove_at_after_current_keeps_position() {
        let mut p = make_player(vec![10, 20, 30, 40], 1);
        // 現在位置は order_pos=1 (曲 20)。order_index=2 (曲 30) を除去。
        assert!(p.remove_at(2));
        assert_order_is_permutation(&p);
        assert_eq!(p.ordered_track_ids(), vec![10, 20, 40]);
        // 現在より後ろの除去なので order_pos は不変。
        assert_eq!(p.order_pos, Some(1));
        assert_eq!(p.current_track_id_from_order(), Some(20));
    }

    #[test]
    fn remove_at_before_current_shifts_position() {
        let mut p = make_player(vec![10, 20, 30, 40], 2);
        // 現在位置は order_pos=2 (曲 30)。order_index=0 (曲 10) を除去。
        assert!(p.remove_at(0));
        assert_order_is_permutation(&p);
        assert_eq!(p.ordered_track_ids(), vec![20, 30, 40]);
        // 現在より前の除去なので order_pos は 1 つ前へ。指す曲は変わらない。
        assert_eq!(p.order_pos, Some(1));
        assert_eq!(p.current_track_id_from_order(), Some(30));
    }

    #[test]
    fn remove_at_rejects_current() {
        let mut p = make_player(vec![10, 20, 30], 1);
        // 現在位置 (order_pos=1) の除去は拒否。
        assert!(!p.remove_at(1));
        assert_eq!(p.ordered_track_ids(), vec![10, 20, 30]);
        assert_eq!(p.order_pos, Some(1));
    }

    #[test]
    fn remove_at_out_of_range() {
        let mut p = make_player(vec![10, 20], 0);
        assert!(!p.remove_at(5));
    }

    #[test]
    fn remove_at_handles_shuffled_indices() {
        // shuffle で order が非自明な並びでも、queue インデックスの詰めが正しいこと。
        let mut p = make_player(vec![10, 20, 30, 40, 50], 0);
        p.set_shuffle(true);
        // 現在位置以外を 1 つ除去しても順列性が保たれる。
        let target = p.order_pos.unwrap() + 1;
        assert!(p.remove_at(target));
        assert_order_is_permutation(&p);
        assert_eq!(p.queue.len(), 4);
    }

    #[test]
    fn move_order_within_up_next() {
        let mut p = make_player(vec![10, 20, 30, 40], 0);
        // order_pos=0。Up Next は index 1,2,3。3 を 1 へ移動。
        assert!(p.move_order(3, 1));
        assert_order_is_permutation(&p);
        assert_eq!(p.ordered_track_ids(), vec![10, 40, 20, 30]);
        // order_pos は動かない。
        assert_eq!(p.order_pos, Some(0));
    }

    #[test]
    fn move_order_rejects_current_or_before() {
        let mut p = make_player(vec![10, 20, 30, 40], 1);
        // order_pos=1。現在位置 (1) や再生済み (0) を含む移動は拒否。
        assert!(!p.move_order(1, 2), "現在位置 from は拒否");
        assert!(!p.move_order(2, 1), "現在位置 to は拒否");
        assert!(!p.move_order(0, 3), "再生済み from は拒否");
        // 許可されるのは order_pos より後ろ同士のみ。
        assert!(p.move_order(2, 3));
        assert_order_is_permutation(&p);
    }

    #[test]
    fn move_order_out_of_range() {
        let mut p = make_player(vec![10, 20, 30], 0);
        assert!(!p.move_order(5, 1));
        assert!(!p.move_order(1, 5));
    }
}
