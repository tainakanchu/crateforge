import { invoke } from "@tauri-apps/api/core";
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

export async function checkAdvance(): Promise<number | null> {
  return invoke("check_advance");
}
