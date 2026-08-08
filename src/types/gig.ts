/** Gig Readiness + Snapshot (#122) */

export type GigSeverity = "ready" | "warning" | "blocker";

export type GigCheckAction =
  | "analyze"
  | "show-missing"
  | "open-sync"
  | "open-export"
  | "dismiss-lint";

export interface GigCheckItem {
  id: string;
  severity: GigSeverity;
  title: string;
  detail: string;
  /** for drill-down */
  trackIds?: number[];
  action?: GigCheckAction;
}

export interface GigReadinessResult {
  status: GigSeverity;
  items: GigCheckItem[];
  summary: {
    total: number;
    missing: number;
    unanalyzed: number;
    durationMs: number;
  };
}

export interface GigSnapshotAnalysis {
  trackId: number;
  bpm: number | null;
  keyCamelot: string | null;
  energy: number | null;
}

export interface GigSnapshot {
  id: string;
  name: string;
  createdAt: string; // ISO
  source: "crate" | "playlist";
  sourceName: string;
  playlistId?: number | null;
  trackIds: number[];
  persistentIds: (string | null)[];
  /** lightweight analysis snapshot */
  analysis: GigSnapshotAnalysis[];
  setMeta?: {
    title: string;
    targetDurationMin: number | null;
    notes: string;
  } | null;
  /** summary at save time */
  summary: {
    total: number;
    missing: number;
    unanalyzed: number;
    durationMs: number;
  };
}
