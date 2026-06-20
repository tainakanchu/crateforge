// 端末再生のキュー＋状態ストア（zustand）。
// 実際の音は AudioEngine 抽象の裏に隠す。これによりストアのキュー/曲送りロジックは
// ネイティブ非依存で単体テストできる。expo-audio 実装（ExpoAudioEngine）は
// playback スライスが提供し、起動時に setEngine で差し込む。

import { create } from "zustand";

import type { Track } from "@/lib/types";

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
}

export interface EngineHandlers {
  onProgress?: (positionMs: number, durationMs: number) => void;
  onFinished?: () => void;
  onPlayingChange?: (playing: boolean) => void;
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
  engine: AudioEngine;

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
  /** 末尾に追加。 */
  enqueue: (track: Track) => void;
  /** 「次に再生」（現在の直後に挿入）。 */
  enqueueNext: (track: Track) => void;
  clear: () => void;

  // エンジン → ストアのイベント受け口（実エンジンから呼ばれる）。
  _onProgress: (positionMs: number, durationMs: number) => void;
  _onFinished: () => void;
  _onPlayingChange: (playing: boolean) => void;
}

/** shuffle 時の次インデックス（現在を避けてランダム）。1 曲以下はそのまま。 */
function randomOtherIndex(length: number, current: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  if (next === current) next = (next + 1) % length;
  return next;
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  index: -1,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  repeat: "off",
  shuffle: false,
  engine: new NoopAudioEngine(),

  current: () => {
    const { queue, index } = get();
    return index >= 0 && index < queue.length ? queue[index] : null;
  },

  setEngine: (engine) => {
    engine.setHandlers({
      onProgress: (p, d) => get()._onProgress(p, d),
      onFinished: () => get()._onFinished(),
      onPlayingChange: (playing) => get()._onPlayingChange(playing),
    });
    set({ engine });
  },

  setQueue: (tracks, startIndex = 0) => {
    set({ queue: tracks, positionMs: 0, durationMs: 0 });
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

  _onProgress: (positionMs, durationMs) => set({ positionMs, durationMs }),
  _onFinished: () => get().next(true),
  _onPlayingChange: (playing) => set({ isPlaying: playing }),
}));

/** テスト用：ストアを初期状態へ戻す（エンジンは Noop に）。 */
export function resetPlayer(): void {
  usePlayer.setState({
    queue: [],
    index: -1,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    repeat: "off",
    shuffle: false,
    engine: new NoopAudioEngine(),
  });
}
