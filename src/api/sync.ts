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
  sourceId: number;
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

export type SyncSelectionPolicy = "snapshot" | "follow" | "writeback";
export type EditableSyncSelectionPolicy = Extract<
  SyncSelectionPolicy,
  "snapshot" | "follow"
>;

export interface SyncSelection {
  id: number;
  remotePid: string;
  name: string;
  policy: SyncSelectionPolicy;
  landingRoot: string | null;
}

export interface ResyncSummary {
  selectionsSynced: number;
  selectionsSkipped: number;
  tracksAdded: number;
  tracksUpdated: number;
  membershipReplaced: number;
  evictionCandidates: number;
  failures: SyncFailure[];
}

export interface EvictionCandidate {
  persistentId: string;
  name: string | null;
  artist: string | null;
  filePath: string | null;
  bytes: number;
  dirty: boolean;
}

export interface EvictionSummary {
  evicted: number;
  filesDeleted: number;
  freedBytes: number;
  failures: SyncFailure[];
}

export interface SelectionStorageUsage {
  selectionId: number;
  name: string;
  trackCount: number;
  bytes: number;
  missingFiles: number;
}

export interface StorageUsageTotal {
  trackCount: number;
  bytes: number;
  missingFiles: number;
}

export interface StorageUsage {
  selections: SelectionStorageUsage[];
  total: StorageUsageTotal;
}

export type ProvisionState = "idle" | "running" | "complete" | "failed";

export interface ProvisionStatus {
  state: ProvisionState;
  summary: ProvisionSummary | null;
  error: string | null;
}

export type WritebackValue = string | number | boolean | null;

export interface WritebackFieldUpdate {
  field: string;
  value: WritebackValue;
  previous: WritebackValue;
}

export interface WritebackTrackChange {
  persistentId: string;
  trackName: string | null;
  fields: WritebackFieldUpdate[];
}

export interface WritebackConflict {
  persistentId: string;
  trackName: string | null;
  field: string;
  local: WritebackValue;
  master: WritebackValue;
  localNewer: boolean;
}

export type WritebackPlaylistOp =
  | {
      op: "create";
      localPlaylistId: number;
      persistentId: string;
      name: string;
      trackPersistentIds: string[];
    }
  | {
      op: "rename";
      persistentId: string;
      masterPlaylistId: number;
      from: string;
      to: string;
    }
  | {
      op: "replaceTracks";
      persistentId: string;
      masterPlaylistId: number;
      name: string;
      trackPersistentIds: string[];
      masterTrackPersistentIds: string[];
      overwritesMasterOrdering: boolean;
    }
  | {
      op: "skippedDelete";
      persistentId: string;
      name: string;
      reason: string;
    };

export interface WritebackPlan {
  planId: string;
  trackChanges: WritebackTrackChange[];
  conflicts: WritebackConflict[];
  playlistOps: WritebackPlaylistOp[];
  pulls: WritebackTrackChange[];
}

export interface WritebackResolution {
  persistentId: string;
  field: string;
  choose: "local" | "master";
}

export interface WritebackSummary {
  pushed: number;
  pulled: number;
  playlistOps: number;
  failures: SyncFailure[];
}

export interface WritebackApplyError {
  code: "stalePlan" | "writebackFailed";
  message: string;
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

export async function syncListSelections(sourceId: number): Promise<SyncSelection[]> {
  return invoke("sync_list_selections", { sourceId });
}

export async function syncSetSelectionPolicy(
  selectionId: number,
  policy: EditableSyncSelectionPolicy,
): Promise<void> {
  return invoke("sync_set_selection_policy", { selectionId, policy });
}

export async function syncRemoveSelection(selectionId: number): Promise<boolean> {
  return invoke("sync_remove_selection", { selectionId });
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

export async function syncWritebackPlan(sourceId: number): Promise<WritebackPlan> {
  return invoke("sync_writeback_plan", { sourceId });
}

export async function syncWritebackApply(
  sourceId: number,
  planId: string,
  resolutions: WritebackResolution[],
): Promise<WritebackSummary> {
  return invoke("sync_writeback_apply", { sourceId, planId, resolutions });
}

export async function syncResync(sourceId: number): Promise<ResyncSummary> {
  return invoke("sync_resync", { sourceId });
}

export async function syncEvictionCandidates(
  sourceId?: number,
): Promise<EvictionCandidate[]> {
  return invoke("sync_eviction_candidates", { sourceId });
}

export async function syncEvict(persistentIds: string[]): Promise<EvictionSummary> {
  return invoke("sync_evict", { persistentIds });
}

export async function syncStorageUsage(sourceId: number): Promise<StorageUsage> {
  return invoke("sync_storage_usage", { sourceId });
}

export function onSyncProgress(cb: (progress: SyncProgress) => void): Promise<UnlistenFn> {
  return listen<SyncProgress>("sync-progress", (event) => cb(event.payload));
}

export function onSyncComplete(cb: (summary: ProvisionSummary) => void): Promise<UnlistenFn> {
  return listen<ProvisionSummary>("sync-complete", (event) => cb(event.payload));
}

export function onResyncComplete(cb: (summary: ResyncSummary) => void): Promise<UnlistenFn> {
  return listen<ResyncSummary>("resync-complete", (event) => cb(event.payload));
}

export function onSyncError(cb: (error: string) => void): Promise<UnlistenFn> {
  return listen<{ error: string }>("sync-error", (event) => cb(event.payload.error));
}

export function onWritebackComplete(
  cb: (summary: WritebackSummary) => void,
): Promise<UnlistenFn> {
  return listen<WritebackSummary>("writeback-complete", (event) => cb(event.payload));
}
