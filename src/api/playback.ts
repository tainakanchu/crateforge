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

/// Rust 側ワーカーが曲を自動送り(または停止)したときに発火する。
/// payload の trackId は再生開始した曲、停止した場合は null。
export async function onPlaybackAdvanced(
  cb: (trackId: number | null) => void,
): Promise<UnlistenFn> {
  return listen<{ trackId: number | null }>("playback-advanced", (e) =>
    cb(e.payload.trackId),
  );
}
