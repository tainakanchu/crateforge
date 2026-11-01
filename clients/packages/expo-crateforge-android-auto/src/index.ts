import { requireOptionalNativeModule } from "expo-modules-core";

import type {
  AndroidAutoSubscription,
  CatalogImportResult,
  EnqueueMode,
  NativeArtistGrouping,
  NativeConnectionInput,
  NativePlaybackState,
  NativeProgressEvent,
  NativeQueueSnapshot,
  NativeRepeatMode,
  NativeTrackJson,
} from "./ExpoCrateforgeAndroidAuto.types";

export type * from "./ExpoCrateforgeAndroidAuto.types";

type AndroidAutoEvents = {
  onStateChange: (s: NativePlaybackState) => void;
  onProgress: (p: NativeProgressEvent) => void;
};

type ExpoCrateforgeAndroidAutoNativeModule = {
  connect(): Promise<NativePlaybackState>;
  getState(): Promise<NativePlaybackState>;
  getQueue(): Promise<NativeQueueSnapshot>;
  setQueue(tracks: NativeTrackJson[], startIndex: number, scope: string | null): Promise<void>;
  playAt(index: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  skipNext(): Promise<void>;
  skipPrevious(): Promise<void>;
  setShuffle(enabled: boolean): Promise<void>;
  setRepeat(mode: NativeRepeatMode): Promise<void>;
  setRate(rate: number): Promise<void>;
  enqueue(tracks: NativeTrackJson[], mode: EnqueueMode, scope: string | null): Promise<void>;
  removeQueueAt(index: number): Promise<void>;
  moveQueueItem(from: number, to: number): Promise<void>;
  moveUpNext(fromOrderPos: number, toOrderPos: number): Promise<void>;
  clearQueue(): Promise<void>;
  setSleepTimer(durationMs: number | null): Promise<void>;
  setStopAtTrackEnd(enabled: boolean): Promise<void>;
  clearError(): Promise<void>;
  migrateLegacySettings(s: { shuffle: boolean | null; repeat: NativeRepeatMode | null }): Promise<boolean>;
  setConnection(c: NativeConnectionInput): Promise<void>;
  clearConnection(): Promise<void>;
  setBrowsePreferences(p: { artistGrouping: NativeArtistGrouping }): Promise<void>;
  notifyDownloadsChanged(): Promise<CatalogImportResult>;
  refreshServerLibrary(): Promise<void>;
  addListener<EventName extends keyof AndroidAutoEvents>(
    eventName: EventName,
    listener: AndroidAutoEvents[EventName],
  ): AndroidAutoSubscription;
};

/**
 * The native module, or `null` when unavailable (iOS, web, Expo Go, jest, or a dev
 * build created before this module was added).
 */
const NativeModule =
  requireOptionalNativeModule<ExpoCrateforgeAndroidAutoNativeModule>("ExpoCrateforgeAndroidAuto");

function unavailable(): Promise<never> {
  const error = new Error("ExpoCrateforgeAndroidAuto native module is unavailable") as Error & {
    code: string;
  };
  error.code = "ERR_UNAVAILABLE";
  return Promise.reject(error);
}

export function isAvailable(): boolean {
  return NativeModule != null;
}

/** Service 起動 + MediaController 接続 + 現状態（復元済み）。 */
export function connect(): Promise<NativePlaybackState> {
  return NativeModule ? NativeModule.connect() : unavailable();
}
export function getState(): Promise<NativePlaybackState> {
  return NativeModule ? NativeModule.getState() : unavailable();
}
export function getQueue(): Promise<NativeQueueSnapshot> {
  return NativeModule ? NativeModule.getQueue() : unavailable();
}
/** 常に再生開始。 */
export function setQueue(tracks: NativeTrackJson[], startIndex: number, scope: string | null): Promise<void> {
  return NativeModule ? NativeModule.setQueue(tracks, startIndex, scope) : unavailable();
}
export function playAt(index: number): Promise<void> {
  return NativeModule ? NativeModule.playAt(index) : unavailable();
}
export function play(): Promise<void> {
  return NativeModule ? NativeModule.play() : unavailable();
}
export function pause(): Promise<void> {
  return NativeModule ? NativeModule.pause() : unavailable();
}
export function stop(): Promise<void> {
  return NativeModule ? NativeModule.stop() : unavailable();
}
export function seekTo(positionMs: number): Promise<void> {
  return NativeModule ? NativeModule.seekTo(positionMs) : unavailable();
}
export function skipNext(): Promise<void> {
  return NativeModule ? NativeModule.skipNext() : unavailable();
}
export function skipPrevious(): Promise<void> {
  return NativeModule ? NativeModule.skipPrevious() : unavailable();
}
export function setShuffle(enabled: boolean): Promise<void> {
  return NativeModule ? NativeModule.setShuffle(enabled) : unavailable();
}
export function setRepeat(mode: NativeRepeatMode): Promise<void> {
  return NativeModule ? NativeModule.setRepeat(mode) : unavailable();
}
export function setRate(rate: number): Promise<void> {
  return NativeModule ? NativeModule.setRate(rate) : unavailable();
}
export function enqueue(tracks: NativeTrackJson[], mode: EnqueueMode, scope: string | null): Promise<void> {
  return NativeModule ? NativeModule.enqueue(tracks, mode, scope) : unavailable();
}
export function removeQueueAt(index: number): Promise<void> {
  return NativeModule ? NativeModule.removeQueueAt(index) : unavailable();
}
export function moveQueueItem(from: number, to: number): Promise<void> {
  return NativeModule ? NativeModule.moveQueueItem(from, to) : unavailable();
}
export function moveUpNext(fromOrderPos: number, toOrderPos: number): Promise<void> {
  return NativeModule ? NativeModule.moveUpNext(fromOrderPos, toOrderPos) : unavailable();
}
export function clearQueue(): Promise<void> {
  return NativeModule ? NativeModule.clearQueue() : unavailable();
}
export function setSleepTimer(durationMs: number | null): Promise<void> {
  return NativeModule ? NativeModule.setSleepTimer(durationMs) : unavailable();
}
export function setStopAtTrackEnd(enabled: boolean): Promise<void> {
  return NativeModule ? NativeModule.setStopAtTrackEnd(enabled) : unavailable();
}
export function clearError(): Promise<void> {
  return NativeModule ? NativeModule.clearError() : unavailable();
}
/** settingsInitialized=false の時だけ適用し true。 */
export function migrateLegacySettings(s: {
  shuffle: boolean | null;
  repeat: NativeRepeatMode | null;
}): Promise<boolean> {
  return NativeModule ? NativeModule.migrateLegacySettings(s) : unavailable();
}
/** serverId=null かつ baseUrl 同一なら既知 serverId を保持。 */
export function setConnection(c: NativeConnectionInput): Promise<void> {
  return NativeModule ? NativeModule.setConnection(c) : unavailable();
}
export function clearConnection(): Promise<void> {
  return NativeModule ? NativeModule.clearConnection() : unavailable();
}
export function setBrowsePreferences(p: { artistGrouping: NativeArtistGrouping }): Promise<void> {
  return NativeModule ? NativeModule.setBrowsePreferences(p) : unavailable();
}
export function notifyDownloadsChanged(): Promise<CatalogImportResult> {
  return NativeModule ? NativeModule.notifyDownloadsChanged() : unavailable();
}
export function refreshServerLibrary(): Promise<void> {
  return NativeModule ? NativeModule.refreshServerLibrary() : unavailable();
}

function noopSubscription(): AndroidAutoSubscription {
  return { remove: () => {} };
}

/** event "onStateChange" */
export function addStateListener(l: (s: NativePlaybackState) => void): AndroidAutoSubscription {
  if (!NativeModule) return noopSubscription();
  return NativeModule.addListener("onStateChange", l);
}
/** event "onProgress" */
export function addProgressListener(l: (p: NativeProgressEvent) => void): AndroidAutoSubscription {
  if (!NativeModule) return noopSubscription();
  return NativeModule.addListener("onProgress", l);
}
