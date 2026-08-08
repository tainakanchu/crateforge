// Gig Snapshot (#122) — localStorage CRUD for readiness snapshots.

import type { Track, TrackAnalysis } from "../types";
import type { SetMeta } from "../types/setWorkspace";
import type { GigSnapshot, GigSnapshotAnalysis } from "../types/gig";

export const GIG_SNAPSHOTS_STORAGE_KEY = "crateforge-gig-snapshots";
/** 保持上限（古いものから捨てる） */
export const GIG_SNAPSHOTS_MAX = 40;

function newId(): string {
  return `gig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSnapshot(raw: unknown): raw is GigSnapshot {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.createdAt === "string" &&
    (o.source === "crate" || o.source === "playlist") &&
    typeof o.sourceName === "string" &&
    Array.isArray(o.trackIds) &&
    Array.isArray(o.persistentIds) &&
    Array.isArray(o.analysis) &&
    o.summary != null &&
    typeof o.summary === "object"
  );
}

export function loadGigSnapshots(): GigSnapshot[] {
  try {
    const raw = localStorage.getItem(GIG_SNAPSHOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSnapshot).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  } catch {
    return [];
  }
}

function persist(list: GigSnapshot[]): void {
  try {
    const capped = list
      .slice()
      .sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      )
      .slice(0, GIG_SNAPSHOTS_MAX);
    localStorage.setItem(GIG_SNAPSHOTS_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // quota / private mode
  }
}

export function saveGigSnapshot(snapshot: GigSnapshot): GigSnapshot[] {
  const list = loadGigSnapshots().filter((s) => s.id !== snapshot.id);
  list.unshift(snapshot);
  persist(list);
  return loadGigSnapshots();
}

export function deleteGigSnapshot(id: string): GigSnapshot[] {
  const list = loadGigSnapshots().filter((s) => s.id !== id);
  persist(list);
  return list;
}

export function getGigSnapshot(id: string): GigSnapshot | null {
  return loadGigSnapshots().find((s) => s.id === id) ?? null;
}

export interface BuildSnapshotInput {
  name: string;
  source: "crate" | "playlist";
  sourceName: string;
  playlistId?: number | null;
  tracks: Track[];
  analysisByTrack: Map<number, TrackAnalysis> | ReadonlyMap<number, TrackAnalysis>;
  setMeta?: SetMeta | null;
}

export function buildGigSnapshot(input: BuildSnapshotInput): GigSnapshot {
  const {
    name,
    source,
    sourceName,
    playlistId = null,
    tracks,
    analysisByTrack,
    setMeta = null,
  } = input;

  const analysis: GigSnapshotAnalysis[] = tracks.map((t) => {
    const a = analysisByTrack.get(t.trackId);
    return {
      trackId: t.trackId,
      bpm: a?.bpm ?? t.bpm ?? null,
      keyCamelot: a?.keyCamelot ?? null,
      energy: a?.energy ?? null,
    };
  });

  let missing = 0;
  let unanalyzed = 0;
  let durationMs = 0;
  for (const t of tracks) {
    durationMs += t.totalTimeMs ?? 0;
    if (!t.fileExists) missing++;
    const a = analysisByTrack.get(t.trackId);
    if (!a || ((!a.vector || a.vector.length === 0) && (a.bpm == null || a.bpm <= 0))) {
      unanalyzed++;
    }
  }

  return {
    id: newId(),
    name: name.trim() || sourceName,
    createdAt: new Date().toISOString(),
    source,
    sourceName,
    playlistId: source === "playlist" ? playlistId : null,
    trackIds: tracks.map((t) => t.trackId),
    persistentIds: tracks.map((t) => t.persistentId),
    analysis,
    setMeta: setMeta
      ? {
          title: setMeta.title,
          targetDurationMin: setMeta.targetDurationMin,
          notes: setMeta.notes,
        }
      : null,
    summary: {
      total: tracks.length,
      missing,
      unanalyzed,
      durationMs,
    },
  };
}

/** default snapshot name: `YYYY-MM-DD {sourceName}` */
export function defaultSnapshotName(sourceName: string, now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const label = sourceName.trim() || "Set";
  return `${y}-${m}-${d} ${label}`;
}
