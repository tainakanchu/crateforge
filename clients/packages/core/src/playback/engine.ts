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

  /** 直近に通知したエラーメッセージ。同じエラーの連続通知（毎フレーム）を防ぐ。 */
  private lastErrorReported: string | null = null;

  /** 現在ロード中のトラック（AAC フォールバック再ロードに使う）。 */
  private currentTrack: Track | null = null;
  /** この曲で既に AAC フォールバックを試したか（無限リトライ防止）。 */
  private triedAacFallback = false;
  /** 現在の音源がローカルファイルか（ローカルは AAC フォールバック対象外）。 */
  private isLocalSource = false;

  constructor() {
    // updateInterval を 500ms にして進捗を定期通知させる。
    this.player = createAudioPlayer(null, { updateInterval: 500 });
    this.player.addListener("playbackStatusUpdate", (st: AudioStatus) => {
      // 再生エラー検知。expo-audio は status.error（string|null）に載せる。
      // 404 / トランスコード失敗 等で鳴らないケースを拾う。
      // リモートストリームの "Source error"（端末非対応コーデック等）は、未リトライなら
      // 一度だけ AAC で再ロードして救済する。ローカル/未接続/AAC でも失敗した場合のみ通知する。
      // status は updateInterval ごとに来るので、同一エラーの重複通知を抑止する。
      if (st.error) {
        const client = useConnection.getState().client;
        // リモート音源かつ未リトライ → ユーザー通知せず AAC で 1 回だけ再ロードして再生。
        if (
          !this.isLocalSource &&
          client &&
          this.currentTrack &&
          !this.triedAacFallback
        ) {
          this.triedAacFallback = true;
          // 本当の失敗（AAC でも鳴らない）を次に拾えるよう、抑止状態をリセット。
          this.lastErrorReported = null;
          this.player.replace(
            client.streamSource(this.currentTrack.trackId, { forceAac: true }),
          );
          this.player.play();
          return;
        }
        // ローカル/未接続/AAC でも失敗 → 従来どおり通知（重複抑止は維持）。
        if (st.error !== this.lastErrorReported) {
          this.lastErrorReported = st.error;
          this.handlers.onError?.(st.error);
        }
        // エラー中は進捗/完了を素通しさせない（誤った didJustFinish 連鎖を避ける）。
        return;
      }
      // 正常に読み込めたらエラー状態をリセット（次の失敗を再通知できるように）。
      if (st.isLoaded) this.lastErrorReported = null;
      // expo-audio は秒単位 → ストアはミリ秒で扱う。
      this.handlers.onProgress?.(st.currentTime * 1000, st.duration * 1000);
      this.handlers.onPlayingChange?.(st.playing);
      if (st.didJustFinish) this.handlers.onFinished?.();
    });
  }

  load(track: Track): void {
    const client = useConnection.getState().client;
    // 新しい音源を読むので、前の曲のエラー抑止状態と AAC フォールバック状態をクリアする。
    this.lastErrorReported = null;
    this.currentTrack = track;
    this.triedAacFallback = false;
    // CRITICAL: メディアは track.trackId（iTunes trackId）で解決する。
    // オフライン保存済みならローカルファイルを優先（client 不要で再生可）。
    // 未保存のときだけ接続中の LAN ストリーム（native=1）を使う。
    const local = useDownloads.getState().getLocalUri(track.trackId);
    if (local) {
      this.isLocalSource = true;
      this.player.replace({ uri: local });
    } else if (client) {
      this.isLocalSource = false;
      this.player.replace(client.streamSource(track.trackId, { native: true }));
    } else {
      // オフラインかつ未ダウンロード → 再生できる音源が無い。
      // 無音で固まらないよう、エラーとしてストアへ通知する（次へスキップ等を促す）。
      this.handlers.onError?.("オフラインのため再生できません（未ダウンロード）");
      return;
    }
    // ロック画面メタを設定（artwork は接続時のみ token 付き URL を渡す）。
    this.player.setActiveForLockScreen(true, {
      title: trackTitle(track),
      artist: trackArtist(track),
      albumTitle: track.album ?? undefined,
      artworkUrl: client?.artworkUrl(track.trackId),
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
