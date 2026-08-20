// DJ 用再生エンジン（expo-audio 実装）。DjEngine 抽象の唯一の実体。
// デッキ A/B に独立した AudioPlayer を 1 個ずつ持ち、同時再生・個別ゲイン/レートを実現する。
// 音源解決は通常プレイヤー（@crateforge/core の ExpoAudioEngine）と同じ:
// オフライン保存済みならローカルファイル優先、未保存なら LAN ストリーム（native=1）、
// 端末非対応コーデックの "Source error" は一度だけ AAC で再ロードして救済する。
// DJ モードは前面前提なのでロック画面メタは設定しない。

import { createAudioPlayer, type AudioPlayer, type AudioStatus } from "expo-audio";

import { useConnection, useDownloads, type Track } from "@crateforge/core";

import type { DeckId } from "./math";
import type { DjEngine, DjEngineHandlers } from "./store";

/** デッキごとの進捗通知間隔（ms）。通常再生(500ms)より細かくして頭出しを扱いやすくする。 */
const UPDATE_INTERVAL_MS = 250;

const DECKS: readonly DeckId[] = ["a", "b"];

/** 1 デッキ分のプレイヤーとフォールバック状態。 */
interface DeckPlayer {
  player: AudioPlayer;
  currentTrack: Track | null;
  /** この曲で既に AAC フォールバックを試したか（無限リトライ防止）。 */
  triedAacFallback: boolean;
  /** 現在の音源がローカルファイルか（ローカルは AAC フォールバック対象外）。 */
  isLocalSource: boolean;
  /** 直近に通知したエラーメッセージ。同じエラーの連続通知（毎ステータス）を防ぐ。 */
  lastErrorReported: string | null;
}

export class ExpoDjEngine implements DjEngine {
  private readonly decks: Record<DeckId, DeckPlayer>;
  private handlers: DjEngineHandlers = {};

  constructor() {
    this.decks = {
      a: this.createDeck("a"),
      b: this.createDeck("b"),
    };
  }

  private createDeck(deck: DeckId): DeckPlayer {
    const state: DeckPlayer = {
      player: createAudioPlayer(null, { updateInterval: UPDATE_INTERVAL_MS }),
      currentTrack: null,
      triedAacFallback: false,
      isLocalSource: false,
      lastErrorReported: null,
    };
    state.player.addListener("playbackStatusUpdate", (st: AudioStatus) => {
      this.onStatus(deck, state, st);
    });
    return state;
  }

  private onStatus(deck: DeckId, state: DeckPlayer, st: AudioStatus): void {
    if (st.error) {
      const client = useConnection.getState().client;
      // リモート音源かつ未リトライ → ユーザー通知せず AAC で 1 回だけ再ロードして再生。
      if (!state.isLocalSource && client && state.currentTrack && !state.triedAacFallback) {
        state.triedAacFallback = true;
        state.lastErrorReported = null;
        state.player.replace(
          client.streamSource(state.currentTrack.trackId, { forceAac: true }),
        );
        return;
      }
      if (st.error !== state.lastErrorReported) {
        state.lastErrorReported = st.error;
        this.handlers.onError?.(deck, st.error);
      }
      return;
    }
    if (st.isLoaded) state.lastErrorReported = null;
    // expo-audio は秒単位 → ストアはミリ秒で扱う。
    this.handlers.onProgress?.(deck, st.currentTime * 1000, st.duration * 1000);
    this.handlers.onPlayingChange?.(deck, st.playing);
    if (st.didJustFinish) this.handlers.onFinished?.(deck);
  }

  load(deck: DeckId, track: Track): void {
    const state = this.decks[deck];
    state.lastErrorReported = null;
    state.currentTrack = track;
    state.triedAacFallback = false;
    // CRITICAL: メディアは track.trackId（iTunes trackId）で解決する。
    const local = useDownloads.getState().getLocalUri(track.trackId);
    const client = useConnection.getState().client;
    if (local) {
      state.isLocalSource = true;
      state.player.replace({ uri: local });
    } else if (client) {
      state.isLocalSource = false;
      state.player.replace(client.streamSource(track.trackId, { native: true }));
    } else {
      this.handlers.onError?.(deck, "オフラインのため再生できません（未ダウンロード）");
    }
  }

  play(deck: DeckId): void {
    this.decks[deck].player.play();
  }

  pause(deck: DeckId): void {
    this.decks[deck].player.pause();
  }

  seekTo(deck: DeckId, seconds: number): void {
    void this.decks[deck].player.seekTo(seconds);
  }

  setGain(deck: DeckId, gain: number): void {
    this.decks[deck].player.volume = gain;
  }

  setRate(deck: DeckId, rate: number): void {
    this.decks[deck].player.setPlaybackRate(rate);
  }

  setHandlers(handlers: DjEngineHandlers): void {
    this.handlers = handlers;
  }

  release(): void {
    for (const deck of DECKS) {
      this.decks[deck].player.remove();
    }
  }
}

/** 実エンジンを生成する（DJ 画面マウント時に呼ぶ）。 */
export function createDjEngine(): DjEngine {
  return new ExpoDjEngine();
}
