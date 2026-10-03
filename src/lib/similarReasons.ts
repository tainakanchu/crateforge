// Similar 候補の「なぜ似ているか」表示用ヘルパー（純関数）。

import { camelotCompatible, formatKey, type KeyNotation } from "./keyNotation";

// Camelot のパース / 互換判定は lib/keyNotation に集約 (#172)。既存 import 互換のため再輸出。
export { camelotCompatible, parseCamelot } from "./keyNotation";

export type SimilarFeatureSlice = {
  bpm?: number | null;
  keyCamelot?: string | null;
  energy?: number | null;
};

export type SimilarReasonKind =
  | "key"
  | "bpm"
  | "energy"
  | "distance"
  | "harmonic";

export type SimilarReasonChip = {
  key: string;
  label: string;
  kind: SimilarReasonKind;
};

function fmtSigned(n: number, digits: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
  const abs = Math.abs(n).toFixed(digits);
  // trim trailing zeros after decimal for compactness, keep at least one digit if needed
  const cleaned = abs.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (n === 0) return `±${cleaned}`;
  return `${sign}${cleaned}`;
}

/**
 * base と hit の解析差分から表示用チップを最大 maxChips 個返す。
 * 優先度: Key → BPM → Energy → Harmonic → Distance。
 * keyCamelot には実効キー (手動上書き ?? 解析値) を渡す。Key チップは notation で表示する。
 */
export function buildSimilarReasons(
  base: SimilarFeatureSlice,
  hit: SimilarFeatureSlice,
  distance: number,
  maxChips = 3,
  notation: KeyNotation = "camelot",
): SimilarReasonChip[] {
  const out: SimilarReasonChip[] = [];

  const bk = base.keyCamelot?.trim() || null;
  const hk = hit.keyCamelot?.trim() || null;
  const fk = (k: string) => formatKey(k, notation) ?? k.toUpperCase();
  if (bk && hk) {
    if (bk.toUpperCase() === hk.toUpperCase()) {
      out.push({ key: "key", label: fk(bk), kind: "key" });
    } else {
      out.push({
        key: "key",
        label: `${fk(bk)} → ${fk(hk)}`,
        kind: "key",
      });
    }
  } else if (hk) {
    out.push({ key: "key", label: fk(hk), kind: "key" });
  }

  if (base.bpm != null && hit.bpm != null && base.bpm > 0) {
    const pct = ((hit.bpm - base.bpm) / base.bpm) * 100;
    // ごく近い場合は絶対差、それ以外は %
    if (Math.abs(pct) < 0.05) {
      out.push({ key: "bpm", label: "BPM ±0", kind: "bpm" });
    } else if (Math.abs(hit.bpm - base.bpm) < 1.5 && Math.abs(pct) < 2) {
      out.push({
        key: "bpm",
        label: `BPM ${fmtSigned(hit.bpm - base.bpm, 1)}`,
        kind: "bpm",
      });
    } else {
      out.push({
        key: "bpm",
        label: `BPM ${fmtSigned(pct, 1)}%`,
        kind: "bpm",
      });
    }
  } else if (hit.bpm != null) {
    out.push({
      key: "bpm",
      label: `BPM ${Math.round(hit.bpm)}`,
      kind: "bpm",
    });
  }

  if (base.energy != null && hit.energy != null) {
    const d = hit.energy - base.energy;
    out.push({
      key: "energy",
      label: `Energy ${fmtSigned(d, 2)}`,
      kind: "energy",
    });
  }

  if (bk && hk && camelotCompatible(bk, hk)) {
    out.push({ key: "harmonic", label: "Harmonic", kind: "harmonic" });
  }

  if (Number.isFinite(distance)) {
    out.push({
      key: "distance",
      label: `d=${distance.toFixed(2)}`,
      kind: "distance",
    });
  }

  // 重複 kind はないが、優先度順で先頭 maxChips
  // Key/BPM/Energy を先に、Harmonic・Distance は空きを埋める
  const priority: SimilarReasonKind[] = [
    "key",
    "bpm",
    "energy",
    "harmonic",
    "distance",
  ];
  const byKind = new Map(out.map((c) => [c.kind, c]));
  const picked: SimilarReasonChip[] = [];
  for (const k of priority) {
    const c = byKind.get(k);
    if (c) picked.push(c);
    if (picked.length >= maxChips) break;
  }
  return picked;
}
