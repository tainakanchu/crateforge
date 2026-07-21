import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Playlist } from "../types";

export interface SyncSource {
  id: number;
  serverId: string;
  name: string | null;
  baseUrl: string;
  lastSyncAt: string | null;
}

export interface PairingStart {
  sessionId: string;
  code: string;
}

export interface PairedSource {
  token: string;
  serverId: string;
  name: string;
}

export interface PlaylistSizeEstimate {
  trackCount: number;
  totalBytes: number;
  missingFiles: number;
}

export interface SyncProgress {
  phase: string;
  current: number;
  total: number;
  trackName: string | null;
}

export interface SyncFailure {
  persistentId: string | null;
  trackName: string | null;
  error: string;
}

export interface ProvisionSummary {
  tracks: number;
  playlists: number;
  bytes: number;
  failures: SyncFailure[];
}

export interface ProvisionStarted {
  started: boolean;
}

export type ProvisionState = "idle" | "running" | "complete" | "failed";

export interface ProvisionStatus {
  state: ProvisionState;
  summary: ProvisionSummary | null;
  error: string | null;
}

export async function syncPairStart(
  baseUrl: string,
  deviceName: string,
): Promise<PairingStart> {
  return invoke("sync_pair_start", { baseUrl, deviceName });
}

export async function syncPairPoll(sessionId: string): Promise<PairedSource | null> {
  return invoke("sync_pair_poll", { sessionId });
}

export async function syncListSources(): Promise<SyncSource[]> {
  return invoke("sync_list_sources");
}

export async function syncListRemotePlaylists(sourceId: number): Promise<Playlist[]> {
  return invoke("sync_list_remote_playlists", { sourceId });
}

export async function syncPlaylistSizeEstimate(
  sourceId: number,
  playlistId: number,
): Promise<PlaylistSizeEstimate> {
  return invoke("sync_playlist_size_estimate", { sourceId, playlistId });
}

export async function syncProvision(
  sourceId: number,
  remotePids: string[],
  destRoot: string,
): Promise<ProvisionStarted> {
  return invoke("sync_provision", { sourceId, remotePids, destRoot });
}

export async function syncProvisionStatus(): Promise<ProvisionStatus> {
  return invoke("sync_provision_status");
}

export function onSyncProgress(cb: (progress: SyncProgress) => void): Promise<UnlistenFn> {
  return listen<SyncProgress>("sync-progress", (event) => cb(event.payload));
}

export function onSyncComplete(cb: (summary: ProvisionSummary) => void): Promise<UnlistenFn> {
  return listen<ProvisionSummary>("sync-complete", (event) => cb(event.payload));
}

export function onSyncError(cb: (error: string) => void): Promise<UnlistenFn> {
  return listen<{ error: string }>("sync-error", (event) => cb(event.payload.error));
}
