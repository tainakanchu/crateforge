// 再生エンジン（expo-audio 実装）。AudioEngine 抽象の唯一の実体。
// プレイヤーストア（@/store/player）はこの裏で音を鳴らし、進捗/完了/再生状態を
// ハンドラ経由で受け取る。ストリーム URL は load() 時に接続中の ApiClient から解決する。
// ロック画面コントロールのために setAudioModeAsync の interruptionMode は "doNotMix" が必須。

import {
  createAudioPlayer,
  setAudioModeAsync,
  requestNotificationPermissionsAsync,
  type AudioPlayer,
  type AudioStatus,
} from "expo-audio";

import type { AudioEngine, EngineHandlers } from "../store/player";
import type { Track } from "../lib/types";
import { useConnection } from "../store/connection";
import { useDownloads } from "../store/downloads";
import { trackTitle, trackArtist } from "../lib/format";

/** expo-audio を用いた AudioEngine 実装。プレイヤーは 1 個だけ生成して使い回す。 */
export class ExpoAudioEngine implements AudioEngine {
  private readonly player: AudioPlayer;
  private handlers: EngineHandlers = {};

  constructor() {
    // updateInterval を 500ms にして進捗を定期通知させる。
    this.player = createAudioPlayer(null, { updateInterval: 500 });
    this.player.addListener("playbackStatusUpdate", (st: AudioStatus) => {
      // expo-audio は秒単位 → ストアはミリ秒で扱う。
      this.handlers.onProgress?.(st.currentTime * 1000, st.duration * 1000);
      this.handlers.onPlayingChange?.(st.playing);
      if (st.didJustFinish) this.handlers.onFinished?.();
    });
  }

  load(track: Track): void {
    const client = useConnection.getState().client;
    if (!client) return;
    // CRITICAL: メディアは track.trackId（iTunes trackId）で解決する。
    // オフライン保存済みならローカルファイルを優先し、無ければ LAN ストリーム（native=1）。
    const local = useDownloads.getState().getLocalUri(track.trackId);
    if (local) this.player.replace({ uri: local });
    else this.player.replace(client.streamSource(track.trackId, { native: true }));
    // ロック画面メタを設定（artwork は token 付き URL）。
    this.player.setActiveForLockScreen(true, {
      title: trackTitle(track),
      artist: trackArtist(track),
      albumTitle: track.album ?? undefined,
      artworkUrl: client.artworkUrl(track.trackId),
    });
  }

  play(): void {
    this.player.play();
  }

  pause(): void {
    this.player.pause();
  }

  seekTo(seconds: number): void {
    void this.player.seekTo(seconds);
  }

  setVolume(volume: number): void {
    this.player.volume = volume;
  }

  setRate(rate: number): void {
    this.player.setPlaybackRate(rate);
  }

  setHandlers(handlers: EngineHandlers): void {
    this.handlers = handlers;
  }

  release(): void {
    this.player.remove();
  }
}

/** 実エンジンを生成する。 */
export function createAudioEngine(): AudioEngine {
  return new ExpoAudioEngine();
}

/** 起動時の音声セッション初期化。バックグラウンド/ロック画面再生を有効化する。 */
export async function initPlayback(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    // ロック画面コントロールには doNotMix が必須。
    interruptionMode: "doNotMix",
  });
  try {
    await requestNotificationPermissionsAsync();
  } catch {
    // Android のみ。失敗しても再生自体は可能なので握りつぶす。
  }
}
