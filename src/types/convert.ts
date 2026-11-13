export type ConvertFormat = "mp3" | "flac" | "alac" | "aac" | "opus" | "wav";

export interface ConvertRequest {
  trackIds: number[];
  format: ConvertFormat;
  /** 非可逆フォーマットのビットレート (kbps)。null なら既定値。 */
  bitrateKbps: number | null;
  outputDir: string;
  addToLibrary: boolean;
}

/** `convert-progress` イベントのペイロード（serde tag="kind", camelCase）。 */
export type ConvertProgress =
  | { kind: "start"; total: number }
  | { kind: "item"; index: number; total: number; name: string; ok: boolean }
  | { kind: "done"; converted: number; failed: number; added: number };

/** 変換ダイアログの方式: 別フォルダへ書き出す / その場で置き換える。 */
export type ConvertMode = "export" | "replace";

/** 置き換え後の元ファイルの扱い。 */
export type OriginalAction = "trash" | "replaced";

export interface ConvertReplaceRequest {
  trackIds: number[];
  format: ConvertFormat;
  bitrateKbps: number | null;
  original: OriginalAction;
}

export type ReplaceItemStatus = "ok" | "skipped" | "failed";

/** 置き換え後の元ファイル (serde tag="kind")。 */
export type OriginalDisposition =
  | { kind: "moved"; to: string }
  | { kind: "missing" }
  | { kind: "keptShared" }
  | { kind: "trashed" }
  | { kind: "leftInPlace" };

export interface ReplaceItemResult {
  trackId: number;
  name: string | null;
  status: ReplaceItemStatus;
  reason: string | null;
  message: string | null;
  warnings: string[];
  sourceCodec: string | null;
  sourceLossless: boolean | null;
  oldLocationPath: string | null;
  newLocationPath: string | null;
  original: OriginalDisposition | null;
}

export interface ReplaceJob {
  jobId: string;
  state: "queued" | "running" | "done" | "failed";
  total: number;
  done: number;
  counts: { ok: number; skipped: number; failed: number };
  results: ReplaceItemResult[];
  error: string | null;
}

/** `convert-replace-progress` イベント。 */
export type ConvertReplaceProgress =
  | { kind: "start"; jobId: string; total: number }
  | { kind: "item"; jobId: string; index: number; total: number; result: ReplaceItemResult }
  | { kind: "done"; job: ReplaceJob };
