// Set History (#123) — localStorage CRUD for gig performance history.
// MVP: frontend-only (same pattern as Gig Snapshots). DB promotion can follow.

import type { SetHistoryEntry, SetHistorySource, SetHistoryUnresolved } from "../types/setHistory";

export const SET_HISTORY_STORAGE_KEY = "crateforge-set-history";
/** 保持上限（古い performedAt から捨てる） */
export const SET_HISTORY_MAX = 100;

function newId(): string {
  return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isEntry(raw: unknown): raw is SetHistoryEntry {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.performedAt === "string" &&
    typeof o.source === "string" &&
    Array.isArray(o.trackIds) &&
    Array.isArray(o.persistentIds) &&
    typeof o.createdAt === "string" &&
    typeof o.updatedAt === "string"
  );
}

function sortByPerformedAtDesc(list: SetHistoryEntry[]): SetHistoryEntry[] {
  return list.slice().sort((a, b) => {
    if (a.performedAt < b.performedAt) return 1;
    if (a.performedAt > b.performedAt) return -1;
    if (a.createdAt < b.createdAt) return 1;
    if (a.createdAt > b.createdAt) return -1;
    return 0;
  });
}

export function loadSetHistories(): SetHistoryEntry[] {
  try {
    const raw = localStorage.getItem(SET_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sortByPerformedAtDesc(parsed.filter(isEntry));
  } catch {
    return [];
  }
}

function persist(list: SetHistoryEntry[]): void {
  try {
    const capped = sortByPerformedAtDesc(list).slice(0, SET_HISTORY_MAX);
    localStorage.setItem(SET_HISTORY_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // quota / private mode
  }
}

export function getSetHistory(id: string): SetHistoryEntry | null {
  return loadSetHistories().find((e) => e.id === id) ?? null;
}

export function listSetHistories(): SetHistoryEntry[] {
  return loadSetHistories();
}

export interface CreateSetHistoryInput {
  name: string;
  eventName?: string;
  performedAt?: string;
  source?: SetHistorySource;
  trackIds?: number[];
  persistentIds?: (string | null)[];
  unresolved?: SetHistoryUnresolved[];
  linkedSnapshotId?: string | null;
  notes?: string;
}

export function createSetHistory(input: CreateSetHistoryInput): SetHistoryEntry {
  const now = new Date().toISOString();
  const trackIds = input.trackIds ?? [];
  const persistentIds =
    input.persistentIds ?? trackIds.map(() => null as string | null);
  const entry: SetHistoryEntry = {
    id: newId(),
    name: (input.name || "Untitled set").trim() || "Untitled set",
    eventName: input.eventName?.trim() || undefined,
    performedAt: input.performedAt || now.slice(0, 10),
    source: input.source ?? "manual",
    trackIds: [...trackIds],
    persistentIds: [...persistentIds],
    unresolved: input.unresolved?.length ? [...input.unresolved] : undefined,
    linkedSnapshotId: input.linkedSnapshotId ?? null,
    notes: input.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const list = loadSetHistories().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  persist(list);
  return entry;
}

/** Upsert by id (create if missing fields complete). */
export function saveSetHistory(entry: SetHistoryEntry): SetHistoryEntry[] {
  const updated: SetHistoryEntry = {
    ...entry,
    name: entry.name.trim() || "Untitled set",
    updatedAt: new Date().toISOString(),
  };
  const list = loadSetHistories().filter((e) => e.id !== updated.id);
  list.unshift(updated);
  persist(list);
  return loadSetHistories();
}

export function deleteSetHistory(id: string): SetHistoryEntry[] {
  const list = loadSetHistories().filter((e) => e.id !== id);
  persist(list);
  return list;
}

export function updateSetHistoryMeta(
  id: string,
  patch: Partial<
    Pick<
      SetHistoryEntry,
      | "name"
      | "eventName"
      | "performedAt"
      | "notes"
      | "linkedSnapshotId"
      | "source"
    >
  >,
): SetHistoryEntry | null {
  const cur = getSetHistory(id);
  if (!cur) return null;
  const next: SetHistoryEntry = {
    ...cur,
    ...patch,
    name: (patch.name ?? cur.name).trim() || "Untitled set",
    updatedAt: new Date().toISOString(),
  };
  saveSetHistory(next);
  return next;
}

/** Replace ordered track list (and aligned persistentIds). */
export function setSetHistoryTracks(
  id: string,
  trackIds: number[],
  persistentIds: (string | null)[],
): SetHistoryEntry | null {
  const cur = getSetHistory(id);
  if (!cur) return null;
  const next: SetHistoryEntry = {
    ...cur,
    trackIds: [...trackIds],
    persistentIds: [...persistentIds],
    updatedAt: new Date().toISOString(),
  };
  saveSetHistory(next);
  return next;
}

export function removeSetHistoryTrack(
  id: string,
  trackId: number,
): SetHistoryEntry | null {
  const cur = getSetHistory(id);
  if (!cur) return null;
  const idxs = cur.trackIds
    .map((tid, i) => (tid === trackId ? i : -1))
    .filter((i) => i >= 0);
  if (idxs.length === 0) return cur;
  // remove first occurrence only
  const i = idxs[0];
  const trackIds = cur.trackIds.slice();
  const persistentIds = cur.persistentIds.slice();
  trackIds.splice(i, 1);
  if (i < persistentIds.length) persistentIds.splice(i, 1);
  return setSetHistoryTracks(id, trackIds, persistentIds);
}

export function reorderSetHistoryTrack(
  id: string,
  fromIndex: number,
  toIndex: number,
): SetHistoryEntry | null {
  const cur = getSetHistory(id);
  if (!cur) return null;
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= cur.trackIds.length ||
    toIndex >= cur.trackIds.length ||
    fromIndex === toIndex
  ) {
    return cur;
  }
  const trackIds = cur.trackIds.slice();
  const persistentIds = cur.persistentIds.slice();
  const [tid] = trackIds.splice(fromIndex, 1);
  trackIds.splice(toIndex, 0, tid);
  if (fromIndex < persistentIds.length) {
    const [pid] = persistentIds.splice(fromIndex, 1);
    persistentIds.splice(Math.min(toIndex, persistentIds.length), 0, pid);
  }
  return setSetHistoryTracks(id, trackIds, persistentIds);
}

/** Append resolved track(s) at end. */
export function appendSetHistoryTracks(
  id: string,
  tracks: Array<{ trackId: number; persistentId: string | null }>,
): SetHistoryEntry | null {
  const cur = getSetHistory(id);
  if (!cur || tracks.length === 0) return cur;
  const trackIds = [...cur.trackIds];
  const persistentIds = [...cur.persistentIds];
  while (persistentIds.length < trackIds.length) persistentIds.push(null);
  for (const t of tracks) {
    trackIds.push(t.trackId);
    persistentIds.push(t.persistentId);
  }
  return setSetHistoryTracks(id, trackIds, persistentIds);
}

/** Resolve one unresolved line by binding a library track; removes that unresolved item. */
export function resolveSetHistoryUnresolved(
  id: string,
  unresolvedIndex: number,
  track: { trackId: number; persistentId: string | null },
): SetHistoryEntry | null {
  const cur = getSetHistory(id);
  if (!cur) return null;
  const unresolved = [...(cur.unresolved ?? [])];
  if (unresolvedIndex < 0 || unresolvedIndex >= unresolved.length) return cur;
  unresolved.splice(unresolvedIndex, 1);
  const trackIds = [...cur.trackIds, track.trackId];
  const persistentIds = [...cur.persistentIds];
  while (persistentIds.length < cur.trackIds.length) persistentIds.push(null);
  persistentIds.push(track.persistentId);
  const next: SetHistoryEntry = {
    ...cur,
    trackIds,
    persistentIds,
    unresolved: unresolved.length > 0 ? unresolved : undefined,
    updatedAt: new Date().toISOString(),
  };
  saveSetHistory(next);
  return next;
}

export function removeSetHistoryUnresolved(
  id: string,
  unresolvedIndex: number,
): SetHistoryEntry | null {
  const cur = getSetHistory(id);
  if (!cur) return null;
  const unresolved = [...(cur.unresolved ?? [])];
  if (unresolvedIndex < 0 || unresolvedIndex >= unresolved.length) return cur;
  unresolved.splice(unresolvedIndex, 1);
  const next: SetHistoryEntry = {
    ...cur,
    unresolved: unresolved.length > 0 ? unresolved : undefined,
    updatedAt: new Date().toISOString(),
  };
  saveSetHistory(next);
  return next;
}

export function defaultHistoryName(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d} Set`;
}

/** Compare planned (snapshot) vs played (history) track id sets. */
export function comparePlannedVsPlayed(
  plannedIds: number[],
  playedIds: number[],
): {
  plannedCount: number;
  playedCount: number;
  skippedIds: number[];
  addedIds: number[];
  commonIds: number[];
} {
  const planned = new Set(plannedIds);
  const played = new Set(playedIds);
  const skippedIds: number[] = [];
  const addedIds: number[] = [];
  const commonIds: number[] = [];
  for (const id of plannedIds) {
    if (played.has(id)) commonIds.push(id);
    else skippedIds.push(id);
  }
  for (const id of playedIds) {
    if (!planned.has(id)) addedIds.push(id);
  }
  return {
    plannedCount: planned.size,
    playedCount: played.size,
    skippedIds,
    addedIds,
    commonIds,
  };
}
