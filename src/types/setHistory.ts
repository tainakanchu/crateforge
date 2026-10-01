/** Set History (#123) — real gig performance history (played order). */

export type SetHistorySource = "manual" | "m3u" | "csv" | "crateforge" | "other";

export interface SetHistoryUnresolved {
  line: string;
  artist?: string;
  title?: string;
  path?: string;
}

export interface SetHistoryEntry {
  id: string;
  name: string;
  eventName?: string;
  /** ISO date or datetime of the performance */
  performedAt: string;
  source: SetHistorySource;
  /** ordered resolved tracks */
  trackIds: number[];
  persistentIds: (string | null)[];
  /** unresolved import lines (for later manual bind) */
  unresolved?: SetHistoryUnresolved[];
  linkedSnapshotId?: string | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** One logical item parsed from M3U/CSV before library matching. */
export interface SetHistoryImportItem {
  /** original line / raw text */
  line: string;
  artist?: string;
  title?: string;
  path?: string;
  durationSec?: number;
}
