// Android ネイティブ再生（expo-crateforge-android-auto）への配線。
// - モジュール → core の NativePlaybackBridge アダプタ（Track ⇄ NativeTrackJson、scope = 接続中の serverId）。
// - 接続情報（baseUrl / token / serverId）をネイティブの暗号化ストアへ共有する（Android Auto が JS 無しで使う）。
// - ダウンロード（index.json / playlists.json）の変更をネイティブカタログへ通知する。
// - ブラウズ設定（アーティストの束ね方）を共有する。
// - アプリの前面復帰時にネイティブの状態を取り直す（裏で Android Auto から操作された分を確実に反映）。
// Android かつモジュールが使えるときだけ setupPlayback から呼ばれる（iOS / TV / Expo Go は通らない）。
// トークンはネイティブへ渡すだけで、ログには一切出さない。

import { AppState } from "react-native";
import * as AndroidAuto from "expo-crateforge-android-auto";

import {
  installNativePlaybackBackend,
  setDownloadsPersistListener,
  useConnection,
  useSettings,
  type ConnectionState,
  type NativePlaybackBridge,
  type SettingsState,
  type Track,
} from "@crateforge/core";

/** ダウンロード変更通知をまとめる間隔（一括 DL で index.json が連続して書かれるため）。 */
export const DOWNLOADS_NOTIFY_DEBOUNCE_MS = 300;

/** Track をネイティブへ渡す JSON として扱う（DTO をそのまま運ぶ。コピーしない）。 */
function toNativeTracks(tracks: Track[]): AndroidAuto.NativeTrackJson[] {
  return tracks as unknown as AndroidAuto.NativeTrackJson[];
}

/** ログ用にエラー分類だけを取り出す（引数・トークンは出さない）。 */
function describeError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return typeof code === "string" ? `${code}: ${message}` : message;
}

/** 接続中ライブラリの scope（/api/health の serverId）。旧サーバー・未確認は null（ネイティブが解決）。 */
function currentScope(): string | null {
  return useConnection.getState().serverId;
}

/** expo-crateforge-android-auto を core の NativePlaybackBridge に合わせるアダプタ。 */
export function createAndroidAutoBridge(): NativePlaybackBridge {
  return {
    connect: () => AndroidAuto.connect(),
    getQueue: () => AndroidAuto.getQueue(),
    addStateListener: (l) => AndroidAuto.addStateListener(l),
    addProgressListener: (l) => AndroidAuto.addProgressListener(l),
    setQueue: (tracks, startIndex) =>
      AndroidAuto.setQueue(toNativeTracks(tracks), startIndex, currentScope()),
    playAt: (i) => AndroidAuto.playAt(i),
    play: () => AndroidAuto.play(),
    pause: () => AndroidAuto.pause(),
    seekTo: (ms) => AndroidAuto.seekTo(ms),
    skipNext: () => AndroidAuto.skipNext(),
    skipPrevious: () => AndroidAuto.skipPrevious(),
    setShuffle: (on) => AndroidAuto.setShuffle(on),
    setRepeat: (m) => AndroidAuto.setRepeat(m),
    setRate: (r) => AndroidAuto.setRate(r),
    enqueue: (tracks, mode) => AndroidAuto.enqueue(toNativeTracks(tracks), mode, currentScope()),
    removeQueueAt: (i) => AndroidAuto.removeQueueAt(i),
    moveQueueItem: (f, t) => AndroidAuto.moveQueueItem(f, t),
    moveUpNext: (f, t) => AndroidAuto.moveUpNext(f, t),
    clearQueue: () => AndroidAuto.clearQueue(),
    setSleepTimer: (ms) => AndroidAuto.setSleepTimer(ms),
    setStopAtTrackEnd: (v) => AndroidAuto.setStopAtTrackEnd(v),
    clearError: () => AndroidAuto.clearError(),
    migrateLegacySettings: (s) => AndroidAuto.migrateLegacySettings(s),
  };
}

/** ネイティブカタログへダウンロード変更を通知する（即時）。失敗はログのみ。 */
export function notifyNativeDownloadsChanged(): void {
  void AndroidAuto.notifyDownloadsChanged().then(
    (result) => {
      if (result.error) console.warn("[android-auto] catalog import error:", result.error);
    },
    (e: unknown) => console.warn("[android-auto] notifyDownloadsChanged failed:", describeError(e)),
  );
}

/** 接続情報の比較キー（同じ値でネイティブを何度も叩かない）。メモリ内比較のみでログには出さない。 */
type ConnectionTuple = Pick<ConnectionState, "baseUrl" | "token" | "serverId">;

function sameConnection(a: ConnectionTuple | null, b: ConnectionTuple): boolean {
  return a != null && a.baseUrl === b.baseUrl && a.token === b.token && a.serverId === b.serverId;
}

export interface AndroidNativePlayback {
  /** 初回同期の完了（失敗しても reject しない）。 */
  ready: Promise<void>;
  /** 配線をすべて外し、JS 再生経路へ戻す（テスト用）。 */
  dispose(): void;
}

/**
 * Android ネイティブ再生を有効にし、接続・ダウンロード・設定の同期を配線する。
 * 呼び出し側（setupPlayback）が 1 回だけ呼ぶ。
 */
export function installAndroidNativePlayback(): AndroidNativePlayback {
  const backend = installNativePlaybackBackend(createAndroidAutoBridge());
  const disposers: (() => void)[] = [];

  // --- 接続情報 ---
  // hydrate 完了前の初期値（baseUrl=null）でネイティブ側の保存済み接続を消さないよう、
  // 復元が終わってから同期を始める。以後は値が変わるたびに共有する。
  let lastConnection: ConnectionTuple | null = null;
  const syncConnection = (s: ConnectionState) => {
    if (!s.hydrated) return;
    const next: ConnectionTuple = { baseUrl: s.baseUrl, token: s.token, serverId: s.serverId };
    if (sameConnection(lastConnection, next)) return;
    lastConnection = next;
    if (next.baseUrl == null) {
      void AndroidAuto.clearConnection().catch((e: unknown) =>
        console.warn("[android-auto] clearConnection failed:", describeError(e)),
      );
      return;
    }
    void AndroidAuto.setConnection({
      baseUrl: next.baseUrl,
      token: next.token,
      serverId: next.serverId,
    }).catch((e: unknown) =>
      console.warn("[android-auto] setConnection failed:", describeError(e)),
    );
  };
  syncConnection(useConnection.getState());
  disposers.push(useConnection.subscribe(syncConnection));

  // --- ダウンロード（index.json / playlists.json の書き出し後）---
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  setDownloadsPersistListener(() => {
    if (notifyTimer != null) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      notifyNativeDownloadsChanged();
    }, DOWNLOADS_NOTIFY_DEBOUNCE_MS);
  });
  disposers.push(() => {
    setDownloadsPersistListener(null);
    if (notifyTimer != null) clearTimeout(notifyTimer);
    notifyTimer = null;
  });

  // --- ブラウズ設定 ---
  let lastGrouping: SettingsState["artistGrouping"] | null = null;
  const syncPreferences = (s: SettingsState) => {
    if (s.artistGrouping === lastGrouping) return;
    lastGrouping = s.artistGrouping;
    void AndroidAuto.setBrowsePreferences({ artistGrouping: s.artistGrouping }).catch((e: unknown) =>
      console.warn("[android-auto] setBrowsePreferences failed:", describeError(e)),
    );
  };
  syncPreferences(useSettings.getState());
  disposers.push(useSettings.subscribe(syncPreferences));

  // --- 前面復帰時の再同期 ---
  // バックグラウンド中も JS が生きていればイベントで追従しているが、Service の再生成などで
  // 取りこぼした場合に備えて、画面を開いた時点の状態を正とする。
  const appState = AppState.addEventListener("change", (next) => {
    if (next === "active") void backend.resync();
  });
  disposers.push(() => appState.remove());

  return {
    ready: backend.ready,
    dispose: () => {
      for (const d of disposers.reverse()) d();
      backend.uninstall();
    },
  };
}
