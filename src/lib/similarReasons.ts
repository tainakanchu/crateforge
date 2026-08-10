// Similar 候補の「なぜ似ているか」表示用ヘルパー（純関数）。

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

/** Camelot コード ("8A" 等) を (番号 1..=12, isMinor=A 面) に分解する。 */
export function parseCamelot(s: string): { num: number; isMinor: boolean } | null {
  const t = s.trim();
  if (t.length < 2) return null;
  const letter = t.slice(-1);
  const isMinor =
    letter === "A" || letter === "a"
      ? true
      : letter === "B" || letter === "b"
        ? false
        : null;
  if (isMinor == null) return null;
  const num = Number(t.slice(0, -1));
  if (!Number.isInteger(num) || num < 1 || num > 12) return null;
  return { num, isMinor };
}

/** Camelot ミキシング互換: 同番号 (同キー or 平行調) か、隣接番号 (±1 環状) で同種。 */
export function camelotCompatible(a: string, b: string): boolean {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return false;
  if (pa.num === pb.num) return true;
  if (pa.isMinor === pb.isMinor) {
    const d = Math.abs(pa.num - pb.num);
    const ring = Math.min(d, 12 - d);
    return ring === 1;
  }
  return false;
}

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
 */
export function buildSimilarReasons(
  base: SimilarFeatureSlice,
  hit: SimilarFeatureSlice,
  distance: number,
  maxChips = 3,
): SimilarReasonChip[] {
  const out: SimilarReasonChip[] = [];

  const bk = base.keyCamelot?.trim() || null;
  const hk = hit.keyCamelot?.trim() || null;
  if (bk && hk) {
    if (bk.toUpperCase() === hk.toUpperCase()) {
      out.push({ key: "key", label: bk.toUpperCase(), kind: "key" });
    } else {
      out.push({
        key: "key",
        label: `${bk.toUpperCase()} → ${hk.toUpperCase()}`,
        kind: "key",
      });
    }
  } else if (hk) {
    out.push({ key: "key", label: hk.toUpperCase(), kind: "key" });
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
