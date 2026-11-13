import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Track, PlaybackState, QueueState, RepeatMode } from "../types";

export async function playTrack(trackId: number): Promise<void> {
  return invoke("play_track", { trackId });
}

export async function pause(): Promise<void> {
  return invoke("pause");
}

export async function resume(): Promise<void> {
  return invoke("resume");
}

export async function stop(): Promise<void> {
  return invoke("stop");
}

export async function seek(positionMs: number): Promise<void> {
  return invoke("seek", { positionMs });
}

export async function getPlaybackState(): Promise<PlaybackState> {
  return invoke("get_playback_state");
}

export async function getRecentTracks(limit?: number): Promise<Track[]> {
  return invoke("get_recent_tracks", { limit });
}

export async function setQueue(
  trackIds: number[],
  startIndex?: number,
): Promise<void> {
  return invoke("set_queue", { trackIds, startIndex });
}

export async function enqueueTrack(trackId: number): Promise<void> {
  return invoke("enqueue_track", { trackId });
}

/// 「次に再生」: 現在再生中の曲の直後に割り込ませる。
export async function enqueueTrackNext(trackId: number): Promise<void> {
  return invoke("enqueue_track_next", { trackId });
}

/// Up Next(再生順)上の指定位置の曲をキューから取り除く。
/// 再生中の位置や範囲外なら false を返す。
export async function removeQueueAt(orderIndex: number): Promise<boolean> {
  return invoke("remove_queue_at", { orderIndex });
}

/// Up Next(再生順)上の曲を並び替える。from・to とも現在位置より後ろのみ可。
/// 不可な場合は false を返す。
export async function moveQueueItem(
  fromOrderIndex: number,
  toOrderIndex: number,
): Promise<boolean> {
  return invoke("move_queue_item", { fromOrderIndex, toOrderIndex });
}

export async function clearQueue(): Promise<void> {
  return invoke("clear_queue");
}

export async function getQueue(): Promise<QueueState> {
  return invoke("get_queue");
}

export async function playQueueAt(orderIndex: number): Promise<number | null> {
  return invoke("play_queue_at", { orderIndex });
}

export async function playNext(): Promise<number | null> {
  return invoke("play_next");
}

export async function playPrev(): Promise<number | null> {
  return invoke("play_prev");
}

export async function setShuffle(on: boolean): Promise<void> {
  return invoke("set_shuffle", { on });
}

export async function setRepeat(mode: RepeatMode): Promise<void> {
  return invoke("set_repeat", { mode });
}

export async function setVolume(volume: number): Promise<void> {
  return invoke("set_volume", { volume });
}

export async function setReplayGain(enabled: boolean): Promise<void> {
  return invoke("set_replaygain", { enabled });
}

/// Preview / Audition モード: ON の間は playCount / lastPlayed / recent を更新しない。
export async function setPreviewMode(enabled: boolean): Promise<void> {
  return invoke("set_preview_mode", { enabled });
}

export async function getPreviewMode(): Promise<boolean> {
  return invoke("get_preview_mode");
}

/// 起動時に前回の再生キュー / 再生状態を DB から復元したか (#159)。
/// true ならバックエンドの shuffle / repeat / volume が正。
export async function getPlaybackRestored(): Promise<boolean> {
  return invoke("get_playback_restored");
}

/// Preview モードを ON にして単曲再生する (キューは置き換えない)。
export async function previewTrack(trackId: number): Promise<void> {
  await setPreviewMode(true);
  await playTrack(trackId);
}

/// Rust 側ワーカーが曲を自動送り(または停止)したときに発火する。
/// payload の trackId は再生開始した曲、停止した場合は null。
export async function onPlaybackAdvanced(
  cb: (trackId: number | null) => void,
): Promise<UnlistenFn> {
  return listen<{ trackId: number | null }>("playback-advanced", (e) =>
    cb(e.payload.trackId),
  );
}

/// キュー (再生順 / 現在位置) が変わったときに発火する (Up Next の再取得用)。
/// バックエンドのキュー変更系コマンドとリモート API (/api/remote/*) が emit する。
export async function onQueueChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("queue-changed", () => cb());
}

/// プレビュー曲が終端に達したとき (auto-advance せず停止したとき) に発火する。
/// フロントは Esc と同じく exitPreview({ restore: true }) する。
export async function onPreviewEnded(cb: () => void): Promise<UnlistenFn> {
  return listen("preview-ended", () => cb());
}

// ===== 出力デバイス (#170) =====

export interface OutputDeviceInfo {
  /// 表示名。選択・永続化のキーでもある (cpal の ID は環境によって安定しないため)。
  name: string;
  /// OS の既定出力デバイスか。
  isDefault: boolean;
}

export interface OutputDevicesState {
  devices: OutputDeviceInfo[];
  /// ユーザーの選択。null = システム既定 (OS の既定出力に追従)。
  selected: string | null;
  /// 実際に鳴っているデバイス (不明なら null)。
  active: string | null;
}

export interface OutputDeviceNotice {
  /// missing: 起動時に保存済みデバイスが見つからなかった / lost: 再生中に抜かれた。
  kind: "missing" | "lost";
  device: string | null;
  active: string | null;
}

export async function listOutputDevices(): Promise<OutputDevicesState> {
  return invoke("list_output_devices");
}

/// 出力デバイスを切り替える (null = システム既定)。再生中の曲・位置・一時停止状態は維持される。
/// 戻り値は実際に開いたデバイス名。
export async function setOutputDevice(name: string | null): Promise<string | null> {
  return invoke("set_output_device", { name });
}

/// バックエンドに積まれた未読の出力デバイス通知を取り出す。
export async function takeOutputDeviceNotices(): Promise<OutputDeviceNotice[]> {
  return invoke("take_output_device_notices");
}

/// 出力デバイス通知が積まれたときに発火する (中身は takeOutputDeviceNotices で取る)。
export async function onOutputDeviceNotice(cb: () => void): Promise<UnlistenFn> {
  return listen("output-device-notice", () => cb());
}
