// 端末再生のキュー＋状態ストア（zustand）。
// 実際の音は AudioEngine 抽象の裏に隠す。これによりストアのキュー/曲送りロジックは
// ネイティブ非依存で単体テストできる。expo-audio 実装（ExpoAudioEngine）は
// playback スライスが提供し、起動時に setEngine で差し込む。
//
// 再生順はデスクトップ（src-tauri/src/audio/mod.rs）と同じ「queue + order 順列」モデル。
// - `queue` は曲の実体（表示・追加順）。
// - `order` は `0..queue.length` の順列で「再生していく順番」。shuffle 時はここが混ざる。
// - `orderPos` は `order` 上の現在位置。Up Next は `order.slice(orderPos + 1)`。
// - `index` は従来通り「再生中トラックの queue インデックス」＝ `order[orderPos]`。
//   （アプリ側の公開 API 互換のため index は queue インデックスのまま据え置く）
// これにより「毎回ランダム抽選」ではなく一巡で重複しない shuffle と、
// prev で直前に再生した曲へ戻る挙動、Up Next の定義が得られる。

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import type { Track } from "../lib/types";

export type RepeatMode = "off" | "all" | "one";

/** shuffle / repeat の永続化キー（settings.ts と同じ SecureStore を使う）。 */
const KEY_SHUFFLE = "crateforge.player.shuffle";
const KEY_REPEAT = "crateforge.player.repeat";

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
  /**
   * 再生順 = `queue` のインデックスの並べ替え。常に `0..queue.length` の順列。
   * shuffle ON のときはここがシャッフルされる（queue 自体は並べ替えない）。
   */
  order: number[];
  /** `order` 上の現在位置。空キューは -1。Up Next はここ以降。 */
  orderPos: number;
  /** 再生中インデックス（queue 側）。空キューは -1。`order[orderPos]` と一致する。 */
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
  /**
   * 再生順で「現在位置より後」のトラック列（Up Next）。
   * React の selector で直接呼ぶと毎回新しい配列になるため、
   * コンポーネントでは `upNextEntries()` を useMemo で使うこと。
   */
  upNext: () => Track[];

  /** 起動時に実エンジンを差し込む。ハンドラ配線も行う。 */
  setEngine: (engine: AudioEngine) => void;

  /** キューを差し替えて startIndex から再生。 */
  setQueue: (tracks: Track[], startIndex?: number) => void;
  /** index（queue インデックス）の曲を頭から再生。再生順の現在位置もそこへ移る。 */
  playAt: (index: number) => void;
  /** 再生/一時停止トグル。 */
  toggle: () => void;
  play: () => void;
  pause: () => void;
  /**
   * 次の曲へ（再生順 `order` を辿る）。auto=true は「曲が自然終了して」呼ばれた場合で、
   * repeat="one" は同じ曲を再生。手動 next は repeat="one" でも次へ進む。
   * 末尾 + repeat="all" は先頭へ（shuffle 時は次の一巡を再シャッフル）。
   */
  next: (auto?: boolean) => void;
  /** 再生順を 1 つ戻る。3秒以降なら現在曲の頭へ。 */
  prev: () => void;
  /** ミリ秒シーク。 */
  seek: (positionMs: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  setShuffle: (shuffle: boolean) => void;
  removeQueueAt: (index: number) => void;
  moveQueueItem: (from: number, to: number) => void;
  /** Up Next（現在位置より後ろ）内で再生順を入れ替える。引数は `order` 上の位置。 */
  moveUpNext: (from: number, to: number) => void;
  setRate: (rate: number) => void;
  setSleepTimer: (ms: number | null) => void;
  setStopAtTrackEnd: (v: boolean) => void;
  /** 末尾に追加。 */
  enqueue: (track: Track) => void;
  /** 「次に再生」（再生順で現在の直後に挿入）。 */
  enqueueNext: (track: Track) => void;
  clear: () => void;

  /** 通知済みエラーを消費して消す（UI 側が表示後に呼ぶ）。 */
  clearError: () => void;

  /** 起動時に SecureStore から shuffle / repeat を復元する。 */
  hydrate: () => Promise<void>;

  // エンジン → ストアのイベント受け口（実エンジンから呼ばれる）。
  _onProgress: (positionMs: number, durationMs: number) => void;
  _onFinished: () => void;
  _onPlayingChange: (playing: boolean) => void;
  /** 再生エラー受け口。ログ→通知用 state→自動スキップ（連続失敗時は停止）を行う。 */
  _onError: (message: string) => void;
}

/** 0..n-1 の自然順。 */
function naturalOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Fisher-Yates（Math.random 依存。テストからは Math.random を差し替えて決定的にできる）。 */
function shuffleInPlace(v: number[]): void {
  for (let i = v.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = v[i];
    v[i] = v[j];
    v[j] = tmp;
  }
}

/**
 * `start`（queue インデックス）を先頭にした再生順を作る。
 * shuffle ON なら残りをシャッフルして start を先頭に、OFF なら自然順で orderPos=start。
 */
function buildOrder(
  length: number,
  start: number,
  shuffle: boolean,
): { order: number[]; orderPos: number } {
  if (length === 0) return { order: [], orderPos: -1 };
  const s = Math.max(0, Math.min(start, length - 1));
  if (!shuffle) return { order: naturalOrder(length), orderPos: s };
  const rest = naturalOrder(length).filter((i) => i !== s);
  shuffleInPlace(rest);
  return { order: [s, ...rest], orderPos: 0 };
}

/**
 * shuffle の ON/OFF を再生順へ反映する（永続化はしない純粋関数）。
 * - ON: これから流す分（現在位置より後）だけシャッフル。再生済みの並びは保持する。
 * - OFF: 自然順へ戻し、現在の曲を現在位置にする。
 */
function reorderForShuffle(
  state: Pick<PlayerState, "queue" | "order" | "orderPos">,
  on: boolean,
): { order: number[]; orderPos: number } {
  const { queue, order, orderPos } = state;
  if (queue.length === 0) return { order: [], orderPos: -1 };
  if (orderPos < 0 || orderPos >= order.length) return buildOrder(queue.length, 0, on);
  if (on) {
    const head = order.slice(0, orderPos + 1);
    const tail = order.slice(orderPos + 1);
    shuffleInPlace(tail);
    return { order: [...head, ...tail], orderPos };
  }
  const cur = order[orderPos];
  return { order: naturalOrder(queue.length), orderPos: cur };
}

/**
 * 再生順で「現在位置より後」のトラック（Up Next）を queue インデックス付きで返す。
 * UI はこれを useMemo して使う（毎レンダーで新配列を作らないため）。
 * `orderIndex` は `order` 上の位置で、moveUpNext にそのまま渡せる。
 */
export function upNextEntries(
  state: Pick<PlayerState, "queue" | "order" | "orderPos">,
): { track: Track; queueIndex: number; orderIndex: number }[] {
  const { queue, order, orderPos } = state;
  if (orderPos < 0) return [];
  const out: { track: Track; queueIndex: number; orderIndex: number }[] = [];
  for (let i = orderPos + 1; i < order.length; i++) {
    const qi = order[i];
    const track = queue[qi];
    if (track != null) out.push({ track, queueIndex: qi, orderIndex: i });
  }
  return out;
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
  order: [],
  orderPos: -1,
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

  upNext: () => upNextEntries(get()).map((e) => e.track),

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
    if (tracks.length === 0) {
      set({
        queue: [],
        order: [],
        orderPos: -1,
        index: -1,
        isPlaying: false,
        positionMs: 0,
        durationMs: 0,
        lastError: null,
      });
      return;
    }
    const i = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const built = buildOrder(tracks.length, i, get().shuffle);
    set({ queue: tracks, ...built, positionMs: 0, durationMs: 0, lastError: null });
    get().playAt(i);
  },

  playAt: (index) => {
    const { queue, order, engine } = get();
    if (index < 0 || index >= queue.length) return;
    const track = queue[index];
    const pos = order.indexOf(index);
    set({
      index,
      orderPos: pos >= 0 ? pos : 0,
      positionMs: 0,
      durationMs: 0,
      isPlaying: true,
    });
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
    const { queue, order, orderPos, index, repeat, shuffle } = get();
    if (queue.length === 0) return;
    if (auto && repeat === "one") {
      get().playAt(index);
      return;
    }
    if (orderPos + 1 < order.length) {
      get().playAt(order[orderPos + 1]);
      return;
    }
    // 再生順の末尾。
    if (repeat === "all") {
      if (shuffle && queue.length > 1) {
        // 次の一巡を再シャッフル（直前の曲が先頭に来ないよう調整）。
        const fresh = naturalOrder(queue.length);
        shuffleInPlace(fresh);
        if (fresh[0] === index) {
          const tmp = fresh[0];
          fresh[0] = fresh[1];
          fresh[1] = tmp;
        }
        set({ order: fresh });
        get().playAt(fresh[0]);
        return;
      }
      get().playAt(order.length > 0 ? order[0] : 0);
      return;
    }
    // 末尾で repeat off：停止。
    get().engine.pause();
    set({ isPlaying: false, positionMs: 0 });
  },

  prev: () => {
    const { order, orderPos, positionMs, queue } = get();
    if (queue.length === 0) return;
    if (positionMs > 3000) {
      get().seek(0);
      return;
    }
    if (orderPos - 1 >= 0) get().playAt(order[orderPos - 1]);
    else get().seek(0);
  },

  seek: (positionMs) => {
    const ms = Math.max(0, positionMs);
    get().engine.seekTo(ms / 1000);
    set({ positionMs: ms });
  },

  setRepeat: (mode) => {
    set({ repeat: mode });
    void SecureStore.setItemAsync(KEY_REPEAT, mode).catch(() => {});
  },

  setShuffle: (shuffle) => {
    const prev = get().shuffle;
    void SecureStore.setItemAsync(KEY_SHUFFLE, shuffle ? "true" : "false").catch(() => {});
    if (prev === shuffle) {
      set({ shuffle });
      return;
    }
    set({ shuffle, ...reorderForShuffle(get(), shuffle) });
  },

  removeQueueAt: (removeIdx) => {
    const { queue, order, orderPos, index } = get();
    if (removeIdx < 0 || removeIdx >= queue.length) return;
    const nextQueue = queue.filter((_, i) => i !== removeIdx);
    if (nextQueue.length === 0) {
      get().engine.pause();
      set({
        queue: [],
        order: [],
        orderPos: -1,
        index: -1,
        isPlaying: false,
        positionMs: 0,
        durationMs: 0,
      });
      return;
    }
    // order から該当エントリを外し、縮んだ queue に合わせて大きい値を 1 つ詰める。
    const removedAtOrder = order.indexOf(removeIdx);
    const nextOrder = order
      .filter((v) => v !== removeIdx)
      .map((v) => (v > removeIdx ? v - 1 : v));
    const shiftPos = removedAtOrder >= 0 && removedAtOrder < orderPos ? 1 : 0;

    if (removeIdx === index) {
      // 現在曲を削除→次の曲へ（末尾なら 1 つ前）。
      const nextIdx = removeIdx < nextQueue.length ? removeIdx : nextQueue.length - 1;
      get().engine.pause();
      set({ queue: nextQueue, order: nextOrder, orderPos: Math.max(0, orderPos - shiftPos) });
      get().playAt(nextIdx);
      return;
    }
    set({
      queue: nextQueue,
      order: nextOrder,
      orderPos: Math.max(0, orderPos - shiftPos),
      index: removeIdx < index ? index - 1 : index,
    });
  },

  moveQueueItem: (from, to) => {
    const { queue, order, orderPos, index, shuffle } = get();
    if (
      from < 0 || from >= queue.length ||
      to < 0 || to >= queue.length ||
      from === to
    ) return;
    const nextQueue = [...queue];
    const [item] = nextQueue.splice(from, 1);
    nextQueue.splice(to, 0, item);
    // 旧 queue インデックス → 新 queue インデックスの写像。
    const remap = (v: number): number => {
      if (v === from) return to;
      if (from < to) return v > from && v <= to ? v - 1 : v;
      return v >= to && v < from ? v + 1 : v;
    };
    const nextIndex = index >= 0 ? remap(index) : index;
    if (shuffle) {
      // shuffle 中は「再生順」を保ったまま queue（表示順）だけ並べ替える。
      // 値を写像するだけなので order は引き続き順列で、orderPos も同じ曲を指す。
      set({ queue: nextQueue, order: order.map(remap), index: nextIndex });
      return;
    }
    // shuffle OFF では再生順＝キュー順。並べ替えがそのまま次に流れる順になる。
    set({
      queue: nextQueue,
      order: naturalOrder(nextQueue.length),
      orderPos: nextIndex >= 0 ? nextIndex : orderPos,
      index: nextIndex,
    });
  },

  moveUpNext: (from, to) => {
    const { order, orderPos } = get();
    const len = order.length;
    if (from < 0 || to < 0 || from >= len || to >= len || from === to) return;
    // Up Next（現在位置より後ろ）のみ許可。再生済み・再生中は動かさない。
    const min = orderPos + 1;
    if (from < min || to < min) return;
    const nextOrder = [...order];
    const [v] = nextOrder.splice(from, 1);
    nextOrder.splice(to, 0, v);
    set({ order: nextOrder });
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
    const { queue, order } = get();
    const nextQueue = [...queue, track];
    set({ queue: nextQueue, order: [...order, nextQueue.length - 1] });
    if (get().index === -1) get().playAt(nextQueue.length - 1);
  },

  enqueueNext: (track) => {
    const { queue, order, orderPos, index } = get();
    if (index < 0) {
      // 再生中の曲が無い＝ただ積んで先頭から再生する。
      const nextQueue = [...queue, track];
      set({ queue: nextQueue, order: [...order, nextQueue.length - 1] });
      get().playAt(0);
      return;
    }
    // queue 上も「現在の直後」に置く（shuffle を切ったときも順序の意図が残るように）。
    const at = index + 1;
    const nextQueue = [...queue.slice(0, at), track, ...queue.slice(at)];
    const nextOrder = order.map((v) => (v >= at ? v + 1 : v));
    nextOrder.splice(Math.min(orderPos + 1, nextOrder.length), 0, at);
    // index は at より小さいので不変、orderPos より後ろへの挿入なので orderPos も不変。
    set({ queue: nextQueue, order: nextOrder });
  },

  clear: () => {
    get().engine.pause();
    set({
      queue: [],
      order: [],
      orderPos: -1,
      index: -1,
      isPlaying: false,
      positionMs: 0,
      durationMs: 0,
    });
  },

  clearError: () => set({ lastError: null }),

  hydrate: async () => {
    try {
      const [shuffleRaw, repeatRaw] = await Promise.all([
        SecureStore.getItemAsync(KEY_SHUFFLE),
        SecureStore.getItemAsync(KEY_REPEAT),
      ]);
      const updates: Partial<PlayerState> = {};
      if (repeatRaw === "off" || repeatRaw === "all" || repeatRaw === "one") {
        updates.repeat = repeatRaw;
      }
      if (shuffleRaw === "true" || shuffleRaw === "false") {
        const on = shuffleRaw === "true";
        updates.shuffle = on;
        // 起動時は通常キューが空だが、既にキューがある場合も順列を保つ。
        if (on !== get().shuffle) Object.assign(updates, reorderForShuffle(get(), on));
      }
      set(updates);
    } catch {
      // 読み出し失敗は既定値のまま。
    }
  },

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
    const { queue, order, orderPos } = get();
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
    // (3) 自動で次の曲へスキップ。次が無い（単曲/末尾 repeat off）なら停止。
    const hasNext = get().repeat === "all" || orderPos + 1 < order.length;
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
    order: [],
    orderPos: -1,
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
