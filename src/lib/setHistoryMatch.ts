// Set History (#123) — match import items against a library track pool.

import type { Track } from "../types";
import type {
  SetHistoryImportItem,
  SetHistoryUnresolved,
} from "../types/setHistory";
import * as libraryApi from "../api/library";

/** Cap for match pool (local MVP — full-library scan deferred to DB later). */
export const SET_HISTORY_MATCH_POOL_MAX = 2000;
const PAGE = 500;

export type MatchResult = {
  trackIds: number[];
  persistentIds: (string | null)[];
  unresolved: SetHistoryUnresolved[];
  resolvedCount: number;
  unresolvedCount: number;
};

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function basename(path: string): string {
  const s = path.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  const base = i >= 0 ? s.slice(i + 1) : s;
  return base;
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

export async function loadMatchPool(
  max = SET_HISTORY_MATCH_POOL_MAX,
): Promise<Track[]> {
  const out: Track[] = [];
  let offset = 0;
  while (out.length < max) {
    const limit = Math.min(PAGE, max - out.length);
    const page = await libraryApi.getTracks(limit, offset, "name", "asc");
    if (page.length === 0) break;
    out.push(...page);
    offset += page.length;
    if (page.length < limit) break;
  }
  return out;
}

type Index = {
  byBasename: Map<string, Track[]>;
  byArtistTitle: Map<string, Track[]>;
  tracks: Track[];
};

function buildIndex(pool: Track[]): Index {
  const byBasename = new Map<string, Track[]>();
  const byArtistTitle = new Map<string, Track[]>();
  for (const t of pool) {
    if (t.locationPath) {
      const b = norm(basename(t.locationPath));
      if (b) {
        const arr = byBasename.get(b) ?? [];
        arr.push(t);
        byBasename.set(b, arr);
      }
      const bNoExt = norm(stripExt(basename(t.locationPath)));
      if (bNoExt && bNoExt !== b) {
        const arr = byBasename.get(bNoExt) ?? [];
        arr.push(t);
        byBasename.set(bNoExt, arr);
      }
    }
    const key = `${norm(t.artist)}\0${norm(t.name)}`;
    if (norm(t.name)) {
      const arr = byArtistTitle.get(key) ?? [];
      arr.push(t);
      byArtistTitle.set(key, arr);
    }
  }
  return { byBasename, byArtistTitle, tracks: pool };
}

function uniqueTracks(list: Track[]): Track[] {
  const seen = new Set<number>();
  const out: Track[] = [];
  for (const t of list) {
    if (seen.has(t.trackId)) continue;
    seen.add(t.trackId);
    out.push(t);
  }
  return out;
}

/**
 * Matching strategy:
 * 1. path basename (exact, case-insensitive) against locationPath
 * 2. case-insensitive artist+title exact
 * 3. fuzzy: title exact + artist contains (or vice versa when artist missing)
 * Ambiguous / no match → unresolved.
 */
export function matchImportItems(
  items: SetHistoryImportItem[],
  pool: Track[],
): MatchResult {
  const index = buildIndex(pool);
  const trackIds: number[] = [];
  const persistentIds: (string | null)[] = [];
  const unresolved: SetHistoryUnresolved[] = [];

  for (const item of items) {
    let candidates: Track[] = [];

    // 1) path basename
    if (item.path) {
      const cleaned = item.path.replace(/^file:\/\//i, "");
      const b = norm(basename(cleaned));
      const bNoExt = norm(stripExt(basename(cleaned)));
      const fromPath = [
        ...(index.byBasename.get(b) ?? []),
        ...(bNoExt !== b ? index.byBasename.get(bNoExt) ?? [] : []),
      ];
      candidates = uniqueTracks(fromPath);
    }

    // 2) artist + title exact
    if (candidates.length !== 1) {
      const title = norm(item.title);
      const artist = norm(item.artist);
      if (title) {
        const exactKey = `${artist}\0${title}`;
        const exact = index.byArtistTitle.get(exactKey) ?? [];
        if (exact.length === 1) {
          candidates = exact;
        } else if (exact.length > 1) {
          candidates = exact;
        } else if (candidates.length === 0) {
          // 3) fuzzy: title exact + artist contains
          const fuzzy: Track[] = [];
          for (const t of index.tracks) {
            if (norm(t.name) !== title) continue;
            const ta = norm(t.artist);
            if (!artist) {
              fuzzy.push(t);
            } else if (ta.includes(artist) || artist.includes(ta)) {
              fuzzy.push(t);
            }
          }
          if (fuzzy.length > 0) candidates = uniqueTracks(fuzzy);
        }
      }
    }

    // path-only title fallback already in item.title from parse
    if (candidates.length !== 1 && !item.path && item.title && !item.artist) {
      const title = norm(item.title);
      const byTitle = index.tracks.filter((t) => norm(t.name) === title);
      if (byTitle.length === 1) candidates = byTitle;
      else if (byTitle.length > 1) candidates = byTitle;
    }

    if (candidates.length === 1) {
      const t = candidates[0];
      trackIds.push(t.trackId);
      persistentIds.push(t.persistentId);
    } else {
      // ambiguous or none
      unresolved.push({
        line: item.line,
        artist: item.artist,
        title: item.title,
        path: item.path,
      });
    }
  }

  return {
    trackIds,
    persistentIds,
    unresolved,
    resolvedCount: trackIds.length,
    unresolvedCount: unresolved.length,
  };
}

export async function matchImportItemsAgainstLibrary(
  items: SetHistoryImportItem[],
): Promise<MatchResult> {
  const pool = await loadMatchPool();
  return matchImportItems(items, pool);
}
