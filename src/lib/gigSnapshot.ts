// Gig Snapshot (#122) — localStorage CRUD for readiness snapshots.

import type { Track, TrackAnalysis } from "../types";
import type { SetMeta } from "../types/setWorkspace";
import type { GigSnapshot } from "../types/gig";

export const GIG_SNAPSHOTS_STORAGE_KEY = "crateforge-gig-snapshots";
/**
 * 保持上限（古いものから捨てる）。
 * 20 に抑える理由: localStorage 容量と、planned-vs-played 比較は trackIds /
 * persistentIds + summary で足りるため（per-track analysis は保存しない）。
 */
export const GIG_SNAPSHOTS_MAX = 20;

/** Gig Readiness でプレイリストを読み込む上限（smart / normal 共通）。 */
export const GIG_PLAYLIST_TRACK_LIMIT = 5_000;

/** Soft cap for a single snapshot JSON (~1.5MB) before attempting persist. */
const SNAPSHOT_MAX_BYTES = 1_500_000;

export type GigSnapshotPersistResult =
  | { ok: true; list: GigSnapshot[] }
  | { ok: false; list: GigSnapshot[]; error: string };

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

function sortNewestFirst(list: GigSnapshot[]): GigSnapshot[] {
  return list
    .slice()
    .sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
}

export function loadGigSnapshots(): GigSnapshot[] {
  try {
    const raw = localStorage.getItem(GIG_SNAPSHOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sortNewestFirst(parsed.filter(isSnapshot));
  } catch {
    return [];
  }
}

/**
 * Persist list (newest-first, capped). On QuotaExceeded / setItem failure,
 * drop oldest entries and retry. Surfaces failure instead of swallowing.
 */
function persist(list: GigSnapshot[]): GigSnapshotPersistResult {
  let capped = sortNewestFirst(list).slice(0, GIG_SNAPSHOTS_MAX);

  // Empty list is a valid write (e.g. delete last snapshot) — only when
  // the caller intentionally passed []. Never fall back to writing [] after
  // a failed non-empty persist (that would wipe existing snapshots).
  for (;;) {
    try {
      localStorage.setItem(GIG_SNAPSHOTS_STORAGE_KEY, JSON.stringify(capped));
      return { ok: true, list: loadGigSnapshots() };
    } catch (err) {
      // Cannot shrink further (newest-only failed, or intentional empty write failed).
      if (capped.length <= 1) {
        const msg =
          err instanceof DOMException && err.name === "QuotaExceededError"
            ? "ストレージ容量不足のため Snapshot を保存できません（storage full / too large）"
            : `Snapshot の保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, list: loadGigSnapshots(), error: msg };
      }
      // Drop oldest (end of newest-first list) and retry.
      capped = capped.slice(0, -1);
    }
  }
}

export function saveGigSnapshot(snapshot: GigSnapshot): GigSnapshotPersistResult {
  // Reject absurdly large single snapshots before writing.
  try {
    const size = new Blob([JSON.stringify(snapshot)]).size;
    if (size > SNAPSHOT_MAX_BYTES) {
      return {
        ok: false,
        list: loadGigSnapshots(),
        error: `Snapshot が大きすぎます（約 ${Math.round(size / 1024)} KB）。曲数を減らしてから再度お試しください。`,
      };
    }
  } catch {
    // Blob may be unavailable in some environments; continue to persist.
  }

  const list = loadGigSnapshots().filter((s) => s.id !== snapshot.id);
  list.unshift(snapshot);
  const result = persist(list);
  if (result.ok && !result.list.some((s) => s.id === snapshot.id)) {
    return {
      ok: false,
      list: result.list,
      error: "Snapshot を保存しましたがリストに反映されませんでした。容量不足の可能性があります。",
    };
  }
  return result;
}

export function deleteGigSnapshot(id: string): GigSnapshotPersistResult {
  const list = loadGigSnapshots().filter((s) => s.id !== id);
  return persist(list);
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

  // analysis は空配列のまま残す（isSnapshot の Array.isArray 互換）。
  // per-track bpm/key/energy は localStorage 肥大化の主因で、詳細 UI も
  // planned-vs-played 比較も使わない（ids + summary で足りる）。
  const analysis: GigSnapshot["analysis"] = [];

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
