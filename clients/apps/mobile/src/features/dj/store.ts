// DJ モードの 2 デッキ＋ミキサー状態ストア（zustand）。
// 実際の音は DjEngine 抽象の裏に隠す（プレイヤーストアと同じ設計）。これにより
// デッキ/クロスフェーダー/キュー/SYNC のロジックはネイティブ非依存で単体テストできる。
// expo-audio 実装（ExpoDjEngine）は features/dj/engine.ts が提供し、DJ 画面の
// マウント時に setEngine で差し込み、アンマウント時に shutdown で解放する。

import { create } from "zustand";

import type { Track } from "@crateforge/core";

import {
  type DeckId,
  DEFAULT_TEMPO_RANGE,
  clamp,
  clamp01,
  crossfaderGains,
  nextTempoRange,
  otherDeck,
  syncTempo,
  tempoToRate,
} from "./math";

/** DJ 用ネイティブ音声バックエンドの抽象。実装は expo-audio（ExpoDjEngine）。 */
export interface DjEngine {
  /** 指定デッキへトラックを読み込む（再生開始は play() で）。 */
  load(deck: DeckId, track: Track): void;
  play(deck: DeckId): void;
  pause(deck: DeckId): void;
  /** 秒単位シーク。 */
  seekTo(deck: DeckId, seconds: number): void;
  /** 最終ゲイン（チャンネルフェーダー × クロスフェーダー）を設定する。 */
  setGain(deck: DeckId, gain: number): void;
  setRate(deck: DeckId, rate: number): void;
  /** ストアへ進捗/完了/再生状態を返すハンドラを登録。 */
  setHandlers(handlers: DjEngineHandlers): void;
  release(): void;
}

export interface DjEngineHandlers {
  onProgress?: (deck: DeckId, positionMs: number, durationMs: number) => void;
  onFinished?: (deck: DeckId) => void;
  onPlayingChange?: (deck: DeckId, playing: boolean) => void;
  /** 再生エラー（読み込み失敗 / 404 / オフライン未DL 等）。 */
  onError?: (deck: DeckId, message: string) => void;
}

/** 何もしないエンジン（差し込み前のデフォルト＆テスト用基底）。 */
export class NoopDjEngine implements DjEngine {
  load(_deck: DeckId, _track: Track): void {}
  play(_deck: DeckId): void {}
  pause(_deck: DeckId): void {}
  seekTo(_deck: DeckId, _seconds: number): void {}
  setGain(_deck: DeckId, _gain: number): void {}
  setRate(_deck: DeckId, _rate: number): void {}
  setHandlers(_handlers: DjEngineHandlers): void {}
  release(): void {}
}

export interface DjDeckState {
  track: Track | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  /** キューポイント（ms）。ロード時は 0。 */
  cueMs: number;
  /** テンポフェーダー位置 (-1..1)。実レートは tempoToRate(tempo, tempoRange)。 */
  tempo: number;
  /** チャンネルフェーダー (0..1)。 */
  volume: number;
  /** ピッチベンドの一時レート倍率（1=なし）。ホールド中のみ ≠1。 */
  nudge: number;
}

function initialDeck(): DjDeckState {
  return {
    track: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    cueMs: 0,
    tempo: 0,
    volume: 1,
    nudge: 1,
  };
}

export interface DjState {
  decks: Record<DeckId, DjDeckState>;
  /** クロスフェーダー位置 (0=A側 .. 1=B側)。中央 0.5 が既定。 */
  crossfader: number;
  /** テンポレンジ（±0.04 / 0.08 / 0.16）。両デッキ共通。 */
  tempoRange: number;
  engine: DjEngine;
  /** 直近のデッキ再生エラー（UI 通知用）。 */
  lastError: { deck: DeckId; message: string; at: number } | null;

  /**
   * DJ 画面マウント時に実エンジンを差し込む。ハンドラ配線と、状態に残っている
   * トラックの再ロード（位置 0・停止）・ゲイン/レートの再適用まで行う。
   */
  setEngine: (engine: DjEngine) => void;
  /** DJ 画面アンマウント時。両デッキ停止＋エンジン解放＋Noop へ戻す。 */
  shutdown: () => void;

  /** デッキへトラックをロード（停止状態・先頭・キュー 0 から）。 */
  loadTrack: (deck: DeckId, track: Track) => void;
  togglePlay: (deck: DeckId) => void;
  /**
   * CUE ボタン（簡易 CDJ 挙動）:
   * - 再生中 → キューポイントへ戻って停止。
   * - 停止中 → 現在位置をキューポイントに設定。
   */
  pressCue: (deck: DeckId) => void;
  /** ミリ秒シーク。 */
  seek: (deck: DeckId, positionMs: number) => void;
  /** テンポフェーダー (-1..1)。 */
  setTempo: (deck: DeckId, tempo: number) => void;
  /** テンポレンジをトグル（±4 → 8 → 16%）。レンジ変更後も実レートを再適用する。 */
  cycleTempoRange: () => void;
  /** チャンネルフェーダー (0..1)。 */
  setVolume: (deck: DeckId, volume: number) => void;
  /** クロスフェーダー (0..1)。 */
  setCrossfader: (x: number) => void;
  /**
   * SYNC: 相手デッキの実効 BPM に自デッキのテンポを合わせる。
   * どちらかの BPM が無ければ false（何もしない）。
   */
  sync: (deck: DeckId) => boolean;
  /** ピッチベンド。factor=null で解除（レートをテンポ由来値へ戻す）。 */
  setNudge: (deck: DeckId, factor: number | null) => void;

  /** 通知済みエラーを消費して消す（UI 側が表示後に呼ぶ）。 */
  clearError: () => void;

  // エンジン → ストアのイベント受け口。
  _onProgress: (deck: DeckId, positionMs: number, durationMs: number) => void;
  _onFinished: (deck: DeckId) => void;
  _onPlayingChange: (deck: DeckId, playing: boolean) => void;
  _onError: (deck: DeckId, message: string) => void;
}

/** deck のフィールドを部分更新した decks を作る。 */
function withDeck(
  decks: Record<DeckId, DjDeckState>,
  deck: DeckId,
  patch: Partial<DjDeckState>,
): Record<DeckId, DjDeckState> {
  return { ...decks, [deck]: { ...decks[deck], ...patch } };
}

export const useDj = create<DjState>((set, get) => {
  /** チャンネルフェーダー × クロスフェーダーの最終ゲインを両デッキへ反映する。 */
  const applyGains = () => {
    const { decks, crossfader, engine } = get();
    const gains = crossfaderGains(crossfader);
    engine.setGain("a", decks.a.volume * gains.a);
    engine.setGain("b", decks.b.volume * gains.b);
  };

  /** テンポ＋ピッチベンドから実レートを求めてエンジンへ反映する。 */
  const applyRate = (deck: DeckId) => {
    const { decks, tempoRange, engine } = get();
    engine.setRate(deck, tempoToRate(decks[deck].tempo, tempoRange) * decks[deck].nudge);
  };

  return {
    decks: { a: initialDeck(), b: initialDeck() },
    crossfader: 0.5,
    tempoRange: DEFAULT_TEMPO_RANGE,
    engine: new NoopDjEngine(),
    lastError: null,

    setEngine: (engine) => {
      engine.setHandlers({
        onProgress: (d, p, dur) => get()._onProgress(d, p, dur),
        onFinished: (d) => get()._onFinished(d),
        onPlayingChange: (d, playing) => get()._onPlayingChange(d, playing),
        onError: (d, message) => get()._onError(d, message),
      });
      set({ engine });
      // 前回セッションのトラックが状態に残っていれば再ロード（先頭・停止から）。
      const { decks } = get();
      for (const deck of ["a", "b"] as const) {
        const track = decks[deck].track;
        if (track) {
          engine.load(deck, track);
          set((s) => ({
            decks: withDeck(s.decks, deck, { isPlaying: false, positionMs: 0, cueMs: 0 }),
          }));
        }
        applyRate(deck);
      }
      applyGains();
    },

    shutdown: () => {
      const { engine } = get();
      engine.pause("a");
      engine.pause("b");
      engine.release();
      set((s) => ({
        engine: new NoopDjEngine(),
        decks: {
          a: { ...s.decks.a, isPlaying: false, positionMs: 0, nudge: 1 },
          b: { ...s.decks.b, isPlaying: false, positionMs: 0, nudge: 1 },
        },
      }));
    },

    loadTrack: (deck, track) => {
      const { engine } = get();
      engine.load(deck, track);
      set((s) => ({
        decks: withDeck(s.decks, deck, {
          track,
          isPlaying: false,
          positionMs: 0,
          durationMs: track.totalTimeMs ?? 0,
          cueMs: 0,
          nudge: 1,
        }),
        lastError: null,
      }));
      // replace 後のプレイヤーにレート/ゲインを適用し直す（実装依存を排除）。
      applyRate(deck);
      applyGains();
    },

    togglePlay: (deck) => {
      const { decks, engine } = get();
      const d = decks[deck];
      if (!d.track) return;
      if (d.isPlaying) {
        engine.pause(deck);
        set((s) => ({ decks: withDeck(s.decks, deck, { isPlaying: false }) }));
      } else {
        engine.play(deck);
        set((s) => ({ decks: withDeck(s.decks, deck, { isPlaying: true }) }));
      }
    },

    pressCue: (deck) => {
      const { decks, engine } = get();
      const d = decks[deck];
      if (!d.track) return;
      if (d.isPlaying) {
        engine.pause(deck);
        engine.seekTo(deck, d.cueMs / 1000);
        set((s) => ({
          decks: withDeck(s.decks, deck, { isPlaying: false, positionMs: d.cueMs }),
        }));
      } else {
        set((s) => ({ decks: withDeck(s.decks, deck, { cueMs: d.positionMs }) }));
      }
    },

    seek: (deck, positionMs) => {
      const ms = Math.max(0, positionMs);
      get().engine.seekTo(deck, ms / 1000);
      set((s) => ({ decks: withDeck(s.decks, deck, { positionMs: ms }) }));
    },

    setTempo: (deck, tempo) => {
      set((s) => ({ decks: withDeck(s.decks, deck, { tempo: clamp(tempo, -1, 1) }) }));
      applyRate(deck);
    },

    cycleTempoRange: () => {
      set((s) => ({ tempoRange: nextTempoRange(s.tempoRange) }));
      applyRate("a");
      applyRate("b");
    },

    setVolume: (deck, volume) => {
      set((s) => ({ decks: withDeck(s.decks, deck, { volume: clamp01(volume) }) }));
      applyGains();
    },

    setCrossfader: (x) => {
      set({ crossfader: clamp01(x) });
      applyGains();
    },

    sync: (deck) => {
      const { decks, tempoRange } = get();
      const other = decks[otherDeck(deck)];
      const tempo = syncTempo(
        decks[deck].track?.bpm ?? null,
        other.track?.bpm ?? null,
        other.tempo,
        tempoRange,
      );
      if (tempo == null) return false;
      get().setTempo(deck, tempo);
      return true;
    },

    setNudge: (deck, factor) => {
      set((s) => ({ decks: withDeck(s.decks, deck, { nudge: factor ?? 1 }) }));
      applyRate(deck);
    },

    clearError: () => set({ lastError: null }),

    _onProgress: (deck, positionMs, durationMs) => {
      set((s) => ({
        decks: withDeck(s.decks, deck, {
          positionMs,
          // 曲メタの totalTimeMs より実測 duration を優先（0 のうちはメタを維持）。
          durationMs: durationMs > 0 ? durationMs : s.decks[deck].durationMs,
        }),
      }));
    },

    _onFinished: (deck) => {
      // DJ モードでは自動で次の曲へは進まない。停止して頭出し可能な状態に戻す。
      set((s) => ({ decks: withDeck(s.decks, deck, { isPlaying: false }) }));
    },

    _onPlayingChange: (deck, playing) => {
      set((s) =>
        s.decks[deck].isPlaying === playing
          ? s
          : { ...s, decks: withDeck(s.decks, deck, { isPlaying: playing }) },
      );
    },

    _onError: (deck, message) => {
      console.warn(`[dj:${deck}] error:`, message);
      set((s) => ({
        decks: withDeck(s.decks, deck, { isPlaying: false }),
        lastError: { deck, message, at: Date.now() },
      }));
    },
  };
});

/** テスト用：ストアを初期状態へ戻す（エンジンは Noop に）。 */
export function resetDj(): void {
  useDj.setState({
    decks: { a: initialDeck(), b: initialDeck() },
    crossfader: 0.5,
    tempoRange: DEFAULT_TEMPO_RANGE,
    engine: new NoopDjEngine(),
    lastError: null,
  });
}
