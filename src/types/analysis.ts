/** 1 曲の音声解析結果（Rust の TrackAnalysis と 1:1）。 */
export interface TrackAnalysis {
  trackId: number;
  version: number;
  analyzedAt: string;
  bpm: number | null;
  keyCamelot: string | null;
  keyName: string | null;
  energy: number | null;
  loudnessLufs: number | null;
  replaygainDb: number | null;
  vector: number[];
}

export interface AnalysisStatus {
  analyzed: number;
  total: number;
}

/** `analysis-progress` イベントのペイロード（serde tag="kind", camelCase）。 */
export type AnalysisProgress =
  | { kind: "start"; total: number }
  | { kind: "item"; trackId: number; done: number; total: number; ok: boolean }
  | { kind: "finished"; analyzed: number; failed: number };
