import type { Track } from "./track";

/** 1 曲の音声解析結果（Rust の TrackAnalysis と 1:1）。 */
export interface TrackAnalysis {
  trackId: number;
  version: number;
  analyzedAt: string;
  bpm: number | null;
  keyCamelot: string | null;
  keyName: string | null;
  /**
   * ユーザーの手動 Key 上書き (Camelot)。tracks 側の値を読み出し時に合成したもの。
   * 未設定ならフィールド自体が無い。表示・判定は lib/keyNotation の effectiveKeyCamelot を使う。
   */
  keyCamelotUser?: string | null;
  energy: number | null;
  loudnessLufs: number | null;
  replaygainDb: number | null;
  vector: number[];
  /** 波形オーバービュー（0..1 のピーク列）。一覧取得では空、get_analysis でのみ充填。 */
  peaks: number[];
}

export interface AnalysisStatus {
  analyzed: number;
  total: number;
}

/** 類似度検索の 1 ヒット（曲 + 距離。小さいほど似ている）。 */
export interface SimilarHit {
  track: Track;
  distance: number;
}

/** `analysis-progress` イベントのペイロード（serde tag="kind", camelCase）。 */
export type AnalysisProgress =
  | { kind: "start"; total: number }
  | { kind: "item"; trackId: number; done: number; total: number; ok: boolean }
  | { kind: "finished"; analyzed: number; failed: number };
