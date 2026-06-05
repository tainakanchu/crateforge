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
