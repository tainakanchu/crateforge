// Constrained smooth order (#121) — Anchor / Section 境界を保持した並び替え。

import type { AnchorKind, CrateAnchors, CrateSection } from "../types/setWorkspace";

export type SmoothOrderFn = (trackIds: number[]) => Promise<number[]>;

/**
 * Anchor 付き曲を固定し、Section 境界をまたがない範囲ごとに
 * `buildSmoothOrder` を適用する。
 *
 * - opening / peak / closing / lock いずれも固定位置
 * - section start は soft wall（その位置から新レンジ、自身は固定しない）
 * - 未解析曲は buildSmoothOrder 側の仕様に従う
 */
export async function buildConstrainedSmoothOrder(
  trackIds: number[],
  anchors: CrateAnchors,
  sections: CrateSection[],
  buildSmooth: SmoothOrderFn,
): Promise<number[]> {
  if (trackIds.length < 2) return [...trackIds];

  const result = [...trackIds];
  const n = result.length;

  const fixed = new Set<number>();
  for (let i = 0; i < n; i++) {
    const kind: AnchorKind | undefined = anchors[result[i]];
    if (kind) fixed.add(i);
  }

  const sectionStartIds = new Set(sections.map((s) => s.startTrackId));

  // free ranges: [start, end) of movable indices
  type Range = { start: number; end: number };
  const freeRanges: Range[] = [];
  let rangeStart: number | null = null;

  for (let i = 0; i < n; i++) {
    const isFixed = fixed.has(i);
    const isSoftWall = i > 0 && sectionStartIds.has(result[i]) && !isFixed;

    if (isFixed) {
      if (rangeStart !== null) {
        freeRanges.push({ start: rangeStart, end: i });
        rangeStart = null;
      }
      continue;
    }

    if (isSoftWall && rangeStart !== null) {
      freeRanges.push({ start: rangeStart, end: i });
      rangeStart = i;
      continue;
    }

    if (rangeStart === null) rangeStart = i;
  }
  if (rangeStart !== null) freeRanges.push({ start: rangeStart, end: n });

  for (const { start, end } of freeRanges) {
    const len = end - start;
    if (len < 2) continue;
    const sub = result.slice(start, end);
    try {
      const ordered = await buildSmooth(sub);
      if (!isPermutationOf(ordered, sub)) continue;
      for (let j = 0; j < ordered.length; j++) {
        result[start + j] = ordered[j];
      }
    } catch {
      // leave sub-range as-is
    }
  }

  return result;
}

function isPermutationOf(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<number, number>();
  for (const id of b) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of a) {
    const c = counts.get(id);
    if (c == null || c <= 0) return false;
    counts.set(id, c - 1);
  }
  return true;
}

/** いずれかの Anchor が付いているか（constrained smooth を使う判定）。 */
export function hasAnyAnchor(anchors: CrateAnchors, trackIds: number[]): boolean {
  for (const id of trackIds) {
    if (anchors[id]) return true;
  }
  return false;
}

/** セクション境界があるか。 */
export function hasSectionSplits(
  sections: CrateSection[],
  trackIds: number[],
): boolean {
  if (sections.length === 0 || trackIds.length === 0) return false;
  const idSet = new Set(trackIds);
  return sections.some(
    (s) => idSet.has(s.startTrackId) && trackIds[0] !== s.startTrackId,
  );
}
