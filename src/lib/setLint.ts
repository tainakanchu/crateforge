// Set Lint (#121) — 非破壊のセット構成警告（純関数）。

import type { Track, TrackAnalysis } from "../types";
import type { CrateAnchors, SetMeta } from "../types/setWorkspace";
import { camelotCompatible } from "./similarReasons";

export type LintSeverity = "warn" | "info";

export interface LintItem {
  key: string;
  severity: LintSeverity;
  message: string;
  trackIds?: number[];
}

function artistKey(t: Track): string | null {
  const a = t.artist?.trim().toLowerCase();
  return a || null;
}

function nameArtistKey(t: Track): string {
  return `${(t.name ?? "").trim().toLowerCase()}::${(t.artist ?? "").trim().toLowerCase()}`;
}

/**
 * Staging crate の構成を検査し、警告リストを返す。
 * 並べ替えや削除は行わない（UI 表示専用）。
 */
export function lintSet(
  crate: Track[],
  analysis: Map<number, TrackAnalysis> | ReadonlyMap<number, TrackAnalysis>,
  meta: SetMeta,
  _anchors: CrateAnchors,
): LintItem[] {
  const items: LintItem[] = [];
  if (crate.length === 0) return items;

  // 同一アーティストが 2 ポジション以内
  for (let i = 0; i < crate.length; i++) {
    const aKey = artistKey(crate[i]);
    if (!aKey) continue;
    for (let j = i + 1; j <= i + 2 && j < crate.length; j++) {
      const bKey = artistKey(crate[j]);
      if (bKey && bKey === aKey) {
        items.push({
          key: `artist-near-${crate[i].trackId}-${crate[j].trackId}`,
          severity: "warn",
          message: `同一アーティストが ${j - i} 曲差: ${crate[i].artist}`,
          trackIds: [crate[i].trackId, crate[j].trackId],
        });
      }
    }
  }

  // 重複 trackId / 同名+同アーティスト
  const seenIds = new Set<number>();
  const seenNameArtist = new Map<string, number>();
  for (const t of crate) {
    if (seenIds.has(t.trackId)) {
      items.push({
        key: `dup-id-${t.trackId}`,
        severity: "warn",
        message: `同一トラックが重複: ${t.name || `#${t.trackId}`}`,
        trackIds: [t.trackId],
      });
    }
    seenIds.add(t.trackId);

    const nak = nameArtistKey(t);
    if (nak !== "::") {
      const prev = seenNameArtist.get(nak);
      if (prev != null) {
        items.push({
          key: `dup-name-${prev}-${t.trackId}`,
          severity: "warn",
          message: `同名曲の重複: ${t.name || "(unknown)"} — ${t.artist || ""}`,
          trackIds: [prev, t.trackId],
        });
      } else {
        seenNameArtist.set(nak, t.trackId);
      }
    }
  }

  // 隣接トラックの BPM / Energy / Key
  for (let i = 0; i < crate.length - 1; i++) {
    const a = crate[i];
    const b = crate[i + 1];
    const aa = analysis.get(a.trackId);
    const ba = analysis.get(b.trackId);

    const bpmA = aa?.bpm ?? a.bpm;
    const bpmB = ba?.bpm ?? b.bpm;
    if (bpmA != null && bpmB != null && bpmA > 0 && bpmB > 0) {
      const pct = Math.abs(bpmB - bpmA) / bpmA;
      if (pct > 0.08) {
        items.push({
          key: `bpm-jump-${a.trackId}-${b.trackId}`,
          severity: "warn",
          message: `BPM ジャンプ ${Math.round(bpmA)}→${Math.round(bpmB)} (${(pct * 100).toFixed(1)}%)`,
          trackIds: [a.trackId, b.trackId],
        });
      }
    }

    if (aa?.energy != null && ba?.energy != null) {
      const d = Math.abs(ba.energy - aa.energy);
      if (d > 0.25) {
        const dir = ba.energy > aa.energy ? "上昇" : "下降";
        items.push({
          key: `energy-jump-${a.trackId}-${b.trackId}`,
          severity: "warn",
          message: `Energy ${dir} ${d.toFixed(2)} (${a.name || "?"} → ${b.name || "?"})`,
          trackIds: [a.trackId, b.trackId],
        });
      }
    }

    const keyA = aa?.keyCamelot?.trim();
    const keyB = ba?.keyCamelot?.trim();
    if (keyA && keyB && !camelotCompatible(keyA, keyB)) {
      items.push({
        key: `key-incompat-${a.trackId}-${b.trackId}`,
        severity: "warn",
        message: `ハーモニック非互換: ${keyA} → ${keyB}`,
        trackIds: [a.trackId, b.trackId],
      });
    }
  }

  // missing file / unanalyzed / low rating
  for (const t of crate) {
    if (!t.fileExists) {
      items.push({
        key: `missing-${t.trackId}`,
        severity: "warn",
        message: `ファイルなし: ${t.name || `#${t.trackId}`}`,
        trackIds: [t.trackId],
      });
    }
    if (!analysis.has(t.trackId)) {
      items.push({
        key: `unanalyzed-${t.trackId}`,
        severity: "info",
        message: `未解析: ${t.name || `#${t.trackId}`}`,
        trackIds: [t.trackId],
      });
    }
    if (t.rating != null && t.rating > 0 && t.rating < 40) {
      items.push({
        key: `low-rating-${t.trackId}`,
        severity: "info",
        message: `低レーティング (${Math.round(t.rating / 20)}★): ${t.name || `#${t.trackId}`}`,
        trackIds: [t.trackId],
      });
    }
  }

  // 目標尺 ±10%
  if (meta.targetDurationMin != null && meta.targetDurationMin > 0) {
    const totalMs = crate.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
    const actualMin = totalMs / 60_000;
    const target = meta.targetDurationMin;
    const ratio = actualMin / target;
    if (ratio > 1.1) {
      items.push({
        key: "duration-over",
        severity: "warn",
        message: `目標尺超過: ${actualMin.toFixed(1)} / ${target} 分 (+${((ratio - 1) * 100).toFixed(0)}%)`,
      });
    } else if (ratio < 0.9) {
      items.push({
        key: "duration-under",
        severity: "info",
        message: `目標尺不足: ${actualMin.toFixed(1)} / ${target} 分 (${((1 - ratio) * 100).toFixed(0)}% 短い)`,
      });
    }
  }

  return items;
}
