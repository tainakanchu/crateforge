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
  /**
   * 類似度計算用の特徴ベクトル。get_analysis（1 曲）では入るが、一覧 get_all_analyses では
   * 送らない（36k 曲分で IPC が十数 MB になるため, #213）。空かどうかは hasAnalysisVector で判定する。
   */
  vector?: number[];
  /** 一覧 get_all_analyses でのみ入る。特徴ベクトルが空でないか。 */
  hasVector?: boolean;
  /** 波形オーバービュー（0..1 のピーク列）。一覧取得では空、get_analysis でのみ充填。 */
  peaks: number[];
}

/** 特徴ベクトルを持つか（一覧の hasVector / 1 曲取得の vector のどちらでも判定できる）。 */
export function hasAnalysisVector(a: Pick<TrackAnalysis, "vector" | "hasVector">): boolean {
  return a.hasVector ?? (a.vector != null && a.vector.length > 0);
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
