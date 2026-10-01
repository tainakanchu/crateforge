// Inbox / Triage (#118) — done/later は localStorage で永続化（DB 変更なし）。
//
// Inbox のソース:
// - 未評価 / 直近追加の候補は dateAdded desc の直近 INBOX_FETCH_LIMIT 件のウィンドウ内のみ
//   （ライブラリ全件は読まない。大規模ライブラリ向け）
// - laterIds は getTracksByIds で常にマージ（ウィンドウ外の later も消えない）

import type { Track } from "../types";

export const TRIAGE_STORAGE_KEY = "crateforge-triage";
/** done/later ID の保持上限（古いものから捨てる） */
export const TRIAGE_MAX_IDS = 5000;
/** Inbox に載せる「最近追加」の日数 */
export const INBOX_DAYS = 14;
/** Inbox 候補取得時の API limit（未評価・直近追加はこのウィンドウ内のみ） */
export const INBOX_FETCH_LIMIT = 500;

export type TriagePersist = {
  doneIds: number[];
  laterIds: number[];
};

function capIds(ids: number[], max = TRIAGE_MAX_IDS): number[] {
  if (ids.length <= max) return ids;
  return ids.slice(ids.length - max);
}

export function loadTriagePersist(): TriagePersist {
  try {
    const raw = localStorage.getItem(TRIAGE_STORAGE_KEY);
    if (!raw) return { doneIds: [], laterIds: [] };
    const parsed = JSON.parse(raw) as Partial<TriagePersist>;
    const doneIds = Array.isArray(parsed.doneIds)
      ? parsed.doneIds.filter((n) => typeof n === "number")
      : [];
    const laterIds = Array.isArray(parsed.laterIds)
      ? parsed.laterIds.filter((n) => typeof n === "number")
      : [];
    return { doneIds: capIds(doneIds), laterIds: capIds(laterIds) };
  } catch {
    return { doneIds: [], laterIds: [] };
  }
}

export function saveTriagePersist(p: TriagePersist): void {
  try {
    localStorage.setItem(
      TRIAGE_STORAGE_KEY,
      JSON.stringify({
        doneIds: capIds(p.doneIds),
        laterIds: capIds(p.laterIds),
      }),
    );
  } catch {
    // quota / private mode — ignore
  }
}

function pushUnique(ids: number[], id: number): number[] {
  const next = ids.filter((x) => x !== id);
  next.push(id);
  return capIds(next);
}

/** 処理済みにする。later からも外す。 */
export function persistMarkDone(trackId: number): TriagePersist {
  const cur = loadTriagePersist();
  const next: TriagePersist = {
    doneIds: pushUnique(cur.doneIds, trackId),
    laterIds: cur.laterIds.filter((x) => x !== trackId),
  };
  saveTriagePersist(next);
  return next;
}

/** 後で処理（Inbox に残す）。done からは外す。 */
export function persistMarkLater(trackId: number): TriagePersist {
  const cur = loadTriagePersist();
  const next: TriagePersist = {
    doneIds: cur.doneIds.filter((x) => x !== trackId),
    laterIds: pushUnique(cur.laterIds, trackId),
  };
  saveTriagePersist(next);
  return next;
}

/** dateAdded が直近 N 日以内か。パース不能なら false。 */
export function isRecentlyAdded(
  dateAdded: string | null | undefined,
  days = INBOX_DAYS,
  nowMs = Date.now(),
): boolean {
  if (!dateAdded) return false;
  const t = Date.parse(dateAdded);
  if (Number.isNaN(t)) return false;
  return nowMs - t <= days * 24 * 60 * 60 * 1000;
}

/**
 * Inbox 候補（渡されたトラック集合に対して）:
 * - not done
 * - (dateAdded within 14 days OR in later set OR rating null/0)
 *
 * 未評価・直近追加は呼び出し側が渡す recent ウィンドウ（INBOX_FETCH_LIMIT）内のみ。
 * later は mergeInboxSources で laterIds 由来トラックを常に合流させる。
 */
export function isInboxCandidate(
  track: Track,
  done: ReadonlySet<number>,
  later: ReadonlySet<number>,
  nowMs = Date.now(),
): boolean {
  if (done.has(track.trackId)) return false;
  if (later.has(track.trackId)) return true;
  const unrated = track.rating == null || track.rating === 0;
  if (unrated) return true;
  return isRecentlyAdded(track.dateAdded, INBOX_DAYS, nowMs);
}

/** 取得済みトラックを Inbox ルールでフィルタ（dateAdded desc 前提のまま） */
export function filterInboxTracks(
  tracks: Track[],
  persist: TriagePersist = loadTriagePersist(),
  nowMs = Date.now(),
): Track[] {
  const done = new Set(persist.doneIds);
  const later = new Set(persist.laterIds);
  return tracks.filter((t) => isInboxCandidate(t, done, later, nowMs));
}

/**
 * recent ウィンドウ + later 用トラックを trackId でマージし、Inbox フィルタを適用。
 * recent を優先（同一 trackId は recent 側）。結果は dateAdded desc で安定ソート。
 */
export function mergeInboxSources(
  recentWindow: Track[],
  laterTracks: Track[],
  persist: TriagePersist = loadTriagePersist(),
  nowMs = Date.now(),
): Track[] {
  const byId = new Map<number, Track>();
  for (const t of recentWindow) {
    byId.set(t.trackId, t);
  }
  for (const t of laterTracks) {
    if (!byId.has(t.trackId)) {
      byId.set(t.trackId, t);
    }
  }
  const merged = Array.from(byId.values());
  merged.sort((a, b) => {
    const ta = a.dateAdded ? Date.parse(a.dateAdded) : NaN;
    const tb = b.dateAdded ? Date.parse(b.dateAdded) : NaN;
    const aOk = !Number.isNaN(ta);
    const bOk = !Number.isNaN(tb);
    if (aOk && bOk) return tb - ta;
    if (aOk) return -1;
    if (bOk) return 1;
    return b.trackId - a.trackId;
  });
  return filterInboxTracks(merged, persist, nowMs);
}
