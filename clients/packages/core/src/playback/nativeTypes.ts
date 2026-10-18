// Android ネイティブ再生（expo-crateforge-android-auto）とやり取りする値の型。
// core はネイティブモジュールに依存しない（TV / iOS に持ち込まない）ため、
// モジュール側 `ExpoCrateforgeAndroidAuto.types.ts` と同形の構造型をここに複製する。
// 形を変えるときは docs/android-auto/design.md §5.1 とモジュール側を同時に更新すること。

export type NativeRepeatMode = "off" | "all" | "one";

/** Crateforge Track DTO の JSON（camelCase）をそのまま運ぶ。trackId 必須。 */
export type NativeTrackJson = { trackId: number } & Record<string, unknown>;

export type NativeErrorCode =
  | "OFFLINE_NOT_DOWNLOADED"
  | "FILE_MISSING"
  | "UNSUPPORTED_FORMAT"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "NETWORK"
  | "TOO_MANY_FAILURES"
  | "UNKNOWN";

export interface NativePlaybackError {
  code: NativeErrorCode;
  message: string;
  trackId: number | null;
  atEpochMs: number;
}

export interface NativePlaybackState {
  /** 発行ごとに単調増加。 */
  revision: number;
  /** キュー内容/順列が変わるたび単調増加（永続化される）。 */
  queueVersion: number;
  queueLength: number;
  /** queue インデックス。空は -1。 */
  index: number;
  /** 空は -1。 */
  orderPos: number;
  currentTrackId: number | null;
  currentScope: string | null;
  /** playWhenReady && state∉{IDLE,ENDED}。 */
  isPlaying: boolean;
  isBuffering: boolean;
  positionMs: number;
  /** 不明は 0。 */
  durationMs: number;
  isSeekable: boolean;
  shuffle: boolean;
  repeat: NativeRepeatMode;
  rate: number;
  sleepTimerMs: number | null;
  sleepTimerEndsAtEpochMs: number | null;
  stopAtTrackEnd: boolean;
  lastError: NativePlaybackError | null;
  /** ネイティブが shuffle/repeat を一度でも保存済みか。 */
  settingsInitialized: boolean;
}

export interface NativeQueueItem {
  scope: string;
  trackId: number;
  track: NativeTrackJson;
}

export interface NativeQueueSnapshot {
  queueVersion: number;
  items: NativeQueueItem[];
  order: number[];
  orderPos: number;
  index: number;
}

export interface NativeProgressEvent {
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
}

export type NativeSubscription = { remove(): void };
