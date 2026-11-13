import type { Track, TrackAnalysis } from "../types";

/** 実効 BPM と、その出どころ (解析値なら表示を薄くしてツールチップで区別する)。 */
export interface EffectiveBpm {
  /** 表示用に整数へ丸めた BPM。 */
  value: number;
  /** タグに BPM が無く、解析値を使っている。 */
  fromAnalysis: boolean;
}

/**
 * 実効 BPM = タグの BPM ?? 解析 BPM (タグ優先)。一覧表示・ソート・検索・スマート条件・
 * Rules・API で同じ定義を使う (Rust: `smart::effective_bpm` / `db::tracks::effective_bpm_expr`)。
 */
export function effectiveBpm(
  t: Pick<Track, "bpm">,
  a: Pick<TrackAnalysis, "bpm"> | null | undefined,
): EffectiveBpm | null {
  if (t.bpm != null && t.bpm > 0) return { value: t.bpm, fromAnalysis: false };
  if (a?.bpm != null && a.bpm > 0) return { value: Math.round(a.bpm), fromAnalysis: true };
  return null;
}

/** 解析値由来の BPM に付けるツールチップ。 */
export const ANALYZED_BPM_TITLE = "解析値（タグに BPM がありません）";
