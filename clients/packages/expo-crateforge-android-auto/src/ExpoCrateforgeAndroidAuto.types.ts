export type NativeRepeatMode = "off" | "all" | "one";
export type NativeArtistGrouping = "artist" | "albumArtist";
/** Crateforge Track DTO の JSON（camelCase）をそのまま運ぶ。trackId 必須。 */
export type NativeTrackJson = { trackId: number } & Record<string, unknown>;
export type NativeErrorCode =
  | "OFFLINE_NOT_DOWNLOADED" | "FILE_MISSING" | "UNSUPPORTED_FORMAT" | "UNAUTHORIZED"
  | "NOT_FOUND" | "SERVER_ERROR" | "NETWORK" | "TOO_MANY_FAILURES" | "UNKNOWN";
export interface NativePlaybackError { code: NativeErrorCode; message: string; trackId: number | null; atEpochMs: number; }
export interface NativePlaybackState {
  revision: number;              // 発行ごとに単調増加
  queueVersion: number;          // キュー内容/順列が変わるたび単調増加（永続化される）
  queueLength: number;
  index: number;                 // queue インデックス。空は -1
  orderPos: number;              // 空は -1
  currentTrackId: number | null;
  currentScope: string | null;
  isPlaying: boolean;            // playWhenReady && state∉{IDLE,ENDED}
  isBuffering: boolean;
  positionMs: number;
  durationMs: number;            // 不明は 0
  isSeekable: boolean;
  shuffle: boolean;
  repeat: NativeRepeatMode;
  rate: number;
  sleepTimerMs: number | null;
  sleepTimerEndsAtEpochMs: number | null;
  stopAtTrackEnd: boolean;
  lastError: NativePlaybackError | null;
  settingsInitialized: boolean;  // ネイティブが shuffle/repeat を一度でも保存済みか
}
export interface NativeQueueItem { scope: string; trackId: number; track: NativeTrackJson; }
export interface NativeQueueSnapshot { queueVersion: number; items: NativeQueueItem[]; order: number[]; orderPos: number; index: number; }
export interface NativeProgressEvent { positionMs: number; durationMs: number; isPlaying: boolean; }
export interface NativeConnectionInput { baseUrl: string; token: string | null; serverId: string | null; }
export interface CatalogImportResult { downloads: number; playlists: number; skipped: number; error: string | null; }
export type EnqueueMode = "end" | "next";
export type AndroidAutoSubscription = { remove(): void };
