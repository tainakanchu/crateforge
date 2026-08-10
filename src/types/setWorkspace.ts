/** Set Workspace (#121) — staging crate 上のセット設計メタ（DB テーブルなし）。 */

export type AnchorKind = "opening" | "peak" | "closing" | "lock";

export const ANCHOR_CYCLE: Array<AnchorKind | null> = [
  null,
  "lock",
  "opening",
  "peak",
  "closing",
];

export interface SetMeta {
  title: string;
  /** 目標尺（分）。null = 未設定 */
  targetDurationMin: number | null;
  notes: string;
}

/** trackId → AnchorKind */
export type CrateAnchors = Record<number, AnchorKind>;

/**
 * セクション境界。crate 順で startTrackId が先頭の曲。
 * index ではなく trackId で持つことで並び替えに強い。
 */
export interface CrateSection {
  id: string;
  name: string;
  startTrackId: number;
}

export const DEFAULT_SET_META: SetMeta = {
  title: "",
  targetDurationMin: null,
  notes: "",
};

/** セクション名テンプレート */
export const SECTION_TEMPLATES = [
  "Opening",
  "Build",
  "Peak",
  "Reset",
  "Closing",
] as const;

export const ANCHOR_LABELS: Record<AnchorKind, string> = {
  lock: "Lock",
  opening: "Opening",
  peak: "Peak",
  closing: "Closing",
};

export const ANCHOR_SHORT: Record<AnchorKind, string> = {
  lock: "L",
  opening: "O",
  peak: "P",
  closing: "C",
};
