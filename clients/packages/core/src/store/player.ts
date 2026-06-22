// 端末再生のキュー＋状態ストア（zustand）。
// 実際の音は AudioEngine 抽象の裏に隠す。これによりストアのキュー/曲送りロジックは
// ネイティブ非依存で単体テストできる。expo-audio 実装（ExpoAudioEngine）は
// playback スライスが提供し、起動時に setEngine で差し込む。

import { create } from "zustand";

import type { Track } from "../lib/types";

export type RepeatMode = "off" | "all" | "one";

/** ネイティブ音声バックエンドの抽象。実装は expo-audio（ExpoAudioEngine）。 */
export interface AudioEngine {
  /** 指定トラックを読み込み、ロック画面メタも更新する（再生開始は play() で）。 */
  load(track: Track): void;
  play(): void;
  pause(): void;
  /** 秒単位シーク。 */
  seekTo(seconds: number): void;
  setVolume(volume: number): void;
  /** ストアへ進捗/完了/再生状態を返すハンドラを登録。 */
  setHandlers(handlers: EngineHandlers): void;
  release(): void;
  setRate(rate: number): void;
}

export interface EngineHandlers {
  onProgress?: (positionMs: number, durationMs: number) => void;
  onFinished?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  /** 再生エラー（読み込み失敗 / 404 / トランスコード失敗 / オフライン未DL 等）。 */
  onError?: (message: string) => void;
}

/** 何もしないエンジン（差し込み前のデフォルト＆テスト用基底）。 */
export class NoopAudioEngine implements AudioEngine {
  load(_track: Track): void {}
  play(): void {}
  pause(): void {}
  seekTo(_seconds: number): void {}
  setVolume(_volume: number): void {}
  setHandlers(_handlers: EngineHandlers): void {}
  release(): void {}
  setRate(_rate: number): void {}
}

export interface PlayerState {
  queue: Track[];
  /** 再生中インデックス。空キューは -1。 */
  index: number;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  repeat: RepeatMode;
  shuffle: boolean;
  playbackRate: number;
  sleepTimerMs: number | null;
  stopAtTrackEnd: boolean;
  engine: AudioEngine;
  /**
   * 直近の再生エラー（UI 通知用）。message は表示文言、at は発生時刻(ms)。
   * at を持たせることで「同じ文言の再発」もUI側が新規イベントとして検知できる。
   * 通知の購読側が消費したら null に戻してよい。
   */
  lastError: { message: string; at: number } | null;

  /** 現在トラック（無ければ null）。 */
  current: () => Track | null;

  /** 起動時に実エンジンを差し込む。ハンドラ配線も行う。 */
  setEngine: (engine: AudioEngine) => void;

  /** キューを差し替えて startIndex から再生。 */
  setQueue: (tracks: Track[], startIndex?: number) => void;
  /** index の曲を頭から再生。 */
  playAt: (index: number) => void;
  /** 再生/一時停止トグル。 */
  toggle: () => void;
  play: () => void;
  pause: () => void;
  /**
   * 次の曲へ。auto=true は「曲が自然終了して」呼ばれた場合で、repeat="one" は同じ曲を再生。
   * 手動 next は repeat="one" でも次へ進む。
   */
  next: (auto?: boolean) => void;
  /** 先頭付近では前の曲、3秒以降なら現在曲の頭へ。 */
  prev: () => void;
  /** ミリ秒シーク。 */
  seek: (positionMs: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  setShuffle: (shuffle: boolean) => void;
  removeQueueAt: (index: number) => void;
  moveQueueItem: (from: number, to: number) => void;
  setRate: (rate: number) => void;
  setSleepTimer: (ms: number | null) => void;
  setStopAtTrackEnd: (v: boolean) => void;
  /** 末尾に追加。 */
  enqueue: (track: Track) => void;
  /** 「次に再生」（現在の直後に挿入）。 */
  enqueueNext: (track: Track) => void;
  clear: () => void;

  /** 通知済みエラーを消費して消す（UI 側が表示後に呼ぶ）。 */
  clearError: () => void;

  // エンジン → ストアのイベント受け口（実エンジンから呼ばれる）。
  _onProgress: (positionMs: number, durationMs: number) => void;
  _onFinished: () => void;
  _onPlayingChange: (playing: boolean) => void;
  /** 再生エラー受け口。ログ→通知用 state→自動スキップ（連続失敗時は停止）を行う。 */
  _onError: (message: string) => void;
}

/** shuffle 時の次インデックス（現在を避けてランダム）。1 曲以下はそのまま。 */
function randomOtherIndex(length: number, current: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  if (next === current) next = (next + 1) % length;
  return next;
}

/**
 * 連続再生失敗の上限。これ以上連続で失敗したら自動スキップを止めて停止する
 * （全曲が鳴らない状況での無限スキップ＝CPU/ネットワーク暴走を防ぐ）。
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 連続再生失敗カウンタ（モジュールローカル）。
 * 成功（実際に再生が始まった/進捗が出た）でリセットする。
 * ストア state ではなくモジュール変数にするのは、UI 再レンダリングを誘発しない
 * 内部カウンタであり、テストからは resetPlayer() でクリアできれば十分なため。
 */
let consecutiveFailures = 0;

/** 連続失敗カウンタをリセットする（再生成功時・キュー操作時に呼ぶ）。 */
function resetFailureCount(): void {
  consecutiveFailures = 0;
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  index: -1,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  repeat: "off",
  shuffle: false,
  playbackRate: 1,
  sleepTimerMs: null,
  stopAtTrackEnd: false,
  engine: new NoopAudioEngine(),
  lastError: null,

  current: () => {
    const { queue, index } = get();
    return index >= 0 && index < queue.length ? queue[index] : null;
  },

  setEngine: (engine) => {
    engine.setHandlers({
      onProgress: (p, d) => get()._onProgress(p, d),
      onFinished: () => get()._onFinished(),
      onPlayingChange: (playing) => get()._onPlayingChange(playing),
      onError: (message) => get()._onError(message),
    });
    set({ engine });
  },

  setQueue: (tracks, startIndex = 0) => {
    // 新しいキューはユーザー操作起点。前の連続失敗状態をクリアして再挑戦させる。
    resetFailureCount();
    set({ queue: tracks, positionMs: 0, durationMs: 0, lastError: null });
    if (tracks.length === 0) {
      set({ index: -1, isPlaying: false });
      return;
    }
    const i = Math.max(0, Math.min(startIndex, tracks.length - 1));
    get().playAt(i);
  },

  playAt: (index) => {
    const { queue, engine } = get();
    if (index < 0 || index >= queue.length) return;
    const track = queue[index];
    set({ index, positionMs: 0, durationMs: 0, isPlaying: true });
    engine.load(track);
    engine.play();
  },

  toggle: () => {
    if (get().isPlaying) get().pause();
    else get().play();
  },
  play: () => {
    if (get().current() == null) return;
    get().engine.play();
    set({ isPlaying: true });
  },
  pause: () => {
    get().engine.pause();
    set({ isPlaying: false });
  },

  next: (auto = false) => {
    const { queue, index, repeat, shuffle } = get();
    if (queue.length === 0) return;
    if (auto && repeat === "one") {
      get().playAt(index);
      return;
    }
    if (shuffle) {
      get().playAt(randomOtherIndex(queue.length, index));
      return;
    }
    if (index + 1 < queue.length) {
      get().playAt(index + 1);
    } else if (repeat === "all") {
      get().playAt(0);
    } else {
      // 末尾で repeat off：停止。
      get().engine.pause();
      set({ isPlaying: false, positionMs: 0 });
    }
  },

  prev: () => {
    const { index, positionMs, queue } = get();
    if (queue.length === 0) return;
    if (positionMs > 3000) {
      get().seek(0);
      return;
    }
    if (index - 1 >= 0) get().playAt(index - 1);
    else get().seek(0);
  },

  seek: (positionMs) => {
    const ms = Math.max(0, positionMs);
    get().engine.seekTo(ms / 1000);
    set({ positionMs: ms });
  },

  setRepeat: (mode) => set({ repeat: mode }),
  setShuffle: (shuffle) => set({ shuffle }),

  removeQueueAt: (removeIdx) => {
    const { queue, index } = get();
    if (removeIdx < 0 || removeIdx >= queue.length) return;
    const nextQueue = queue.filter((_, i) => i !== removeIdx);
    if (nextQueue.length === 0) {
      get().engine.pause();
      set({ queue: [], index: -1, isPlaying: false, positionMs: 0, durationMs: 0 });
      return;
    }
    if (removeIdx < index) {
      // 現在より前を削除→インデックスを 1 減らす（同じ曲を維持）。
      set({ queue: nextQueue, index: index - 1 });
    } else if (removeIdx === index) {
      // 現在曲を削除→次の曲へ（末尾なら 1 つ前）。
      const nextIdx = removeIdx < nextQueue.length ? removeIdx : nextQueue.length - 1;
      get().engine.pause();
      set({ queue: nextQueue });
      get().playAt(nextIdx);
    } else {
      set({ queue: nextQueue });
    }
  },

  moveQueueItem: (from, to) => {
    const { queue, index } = get();
    if (
      from < 0 || from >= queue.length ||
      to < 0 || to >= queue.length ||
      from === to
    ) return;
    const nextQueue = [...queue];
    const [item] = nextQueue.splice(from, 1);
    nextQueue.splice(to, 0, item);
    // index が指す「再生中の曲」が移動後も同じトラックを指すよう調整。
    let nextIndex = index;
    if (from === index) {
      nextIndex = to;
    } else if (from < index && to >= index) {
      nextIndex = index - 1;
    } else if (from > index && to <= index) {
      nextIndex = index + 1;
    }
    set({ queue: nextQueue, index: nextIndex });
  },

  setRate: (rate) => {
    const clamped = Math.max(0.5, Math.min(2.0, rate));
    get().engine.setRate(clamped);
    set({ playbackRate: clamped });
  },

  setSleepTimer: (ms) => {
    set({ sleepTimerMs: ms, stopAtTrackEnd: false });
  },

  setStopAtTrackEnd: (v) => {
    set({ stopAtTrackEnd: v, sleepTimerMs: null });
  },

  enqueue: (track) => {
    const { queue } = get();
    const nextQueue = [...queue, track];
    set({ queue: nextQueue });
    if (get().index === -1) get().playAt(nextQueue.length - 1);
  },

  enqueueNext: (track) => {
    const { queue, index } = get();
    const at = index < 0 ? queue.length : index + 1;
    const nextQueue = [...queue.slice(0, at), track, ...queue.slice(at)];
    set({ queue: nextQueue });
    if (get().index === -1) get().playAt(0);
  },

  clear: () => {
    get().engine.pause();
    set({ queue: [], index: -1, isPlaying: false, positionMs: 0, durationMs: 0 });
  },

  clearError: () => set({ lastError: null }),

  _onProgress: (positionMs, durationMs) => {
    // 実際に再生位置が進んだ＝この曲は鳴っている。連続失敗カウンタをリセット。
    if (positionMs > 0) resetFailureCount();
    set({ positionMs, durationMs });
  },
  _onFinished: () => get().next(true),
  _onPlayingChange: (playing) => set({ isPlaying: playing }),

  _onError: (message) => {
    // (1) ログ出力（クラッシュ調査・原因切り分け用）。
    console.warn("[playback] error:", message);
    consecutiveFailures += 1;
    const { queue, index } = get();
    // 連続失敗が上限に達したら、無限スキップを避けて停止し通知する。
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      get().engine.pause();
      set({
        isPlaying: false,
        // (2) ユーザー通知（UI 購読側が表示）。
        lastError: {
          message: "再生できない曲が続いたため停止しました",
          at: Date.now(),
        },
      });
      resetFailureCount();
      return;
    }
    // (2) ユーザー通知用 state を立てる（UI が toast/alert を出す）。
    set({ lastError: { message, at: Date.now() } });
    // (3) 自動で次の曲へスキップ。キューに次が無い（単曲/末尾 repeat off）なら停止。
    const hasNext =
      get().repeat === "all" || get().shuffle || index + 1 < queue.length;
    if (hasNext && queue.length > 0) {
      // auto=true: repeat one でも「鳴らない同じ曲」を無限に再試行しないよう next 側で扱う。
      // ただし repeat one だと同じ曲に戻るため、ここでは手動相当（auto=false）で前進させる。
      get().next(false);
    } else {
      get().engine.pause();
      set({ isPlaying: false });
    }
  },
}));

/** テスト用：ストアを初期状態へ戻す（エンジンは Noop に）。 */
export function resetPlayer(): void {
  resetFailureCount();
  usePlayer.setState({
    queue: [],
    index: -1,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    repeat: "off",
    shuffle: false,
    playbackRate: 1,
    sleepTimerMs: null,
    stopAtTrackEnd: false,
    engine: new NoopAudioEngine(),
    lastError: null,
  });
}
