// Gig Readiness (#122) — pure check logic for Playlist / Staging Crate.

import type { Track, TrackAnalysis } from "../types";
import type { CrateAnchors, SetMeta } from "../types/setWorkspace";
import type {
  GigCheckItem,
  GigReadinessResult,
  GigSeverity,
} from "../types/gig";
import { lintSet } from "./setLint";
import { DEFAULT_SET_META } from "../types/setWorkspace";

export interface GigReadinessInput {
  tracks: Track[];
  analysisByTrack: Map<number, TrackAnalysis> | ReadonlyMap<number, TrackAnalysis>;
  setMeta?: SetMeta | null;
  /** for lintSet only (crate mode). Empty object if not applicable. */
  anchors?: CrateAnchors;
  autoExportEnabled?: boolean;
  autoExportPath?: string | null;
  /** include setLint composition warnings (default true) */
  includeLint?: boolean;
}

function isUnanalyzed(
  track: Track,
  analysis: Map<number, TrackAnalysis> | ReadonlyMap<number, TrackAnalysis>,
): boolean {
  const a = analysis.get(track.trackId);
  if (!a) return true;
  const emptyVector = !a.vector || a.vector.length === 0;
  const noBpm = a.bpm == null || a.bpm <= 0;
  // 解析行はあるが実質未解析（vector も bpm も無い）
  if (emptyVector && noBpm) return true;
  return false;
}

function nameArtistKey(t: Track): string {
  return `${(t.name ?? "").trim().toLowerCase()}::${(t.artist ?? "").trim().toLowerCase()}`;
}

function overallStatus(items: GigCheckItem[]): GigSeverity {
  if (items.some((i) => i.severity === "blocker")) return "blocker";
  if (items.some((i) => i.severity === "warning")) return "warning";
  return "ready";
}

/**
 * Run Gig Readiness checks. Pure: no I/O, no store.
 */
export function runGigReadiness(input: GigReadinessInput): GigReadinessResult {
  const {
    tracks,
    analysisByTrack,
    setMeta = null,
    anchors = {},
    autoExportEnabled = false,
    autoExportPath = null,
    includeLint = true,
  } = input;

  const items: GigCheckItem[] = [];
  const durationMs = tracks.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);

  if (tracks.length === 0) {
    items.push({
      id: "empty",
      severity: "blocker",
      title: "曲なし",
      detail: "チェック対象のトラックがありません。Crate に曲を入れるかプレイリストを選んでください。",
    });
    return {
      status: "blocker",
      items,
      summary: { total: 0, missing: 0, unanalyzed: 0, durationMs: 0 },
    };
  }

  // 1. Blocker: missing files
  const missing = tracks.filter((t) => !t.fileExists);
  if (missing.length > 0) {
    items.push({
      id: "missing",
      severity: "blocker",
      title: `${missing.length} ファイルが見つかりません`,
      detail: "ロケーションが無効、またはファイルが移動/削除されています。ギグ前にパスを直すか同期先へ再配置してください。",
      trackIds: missing.map((t) => t.trackId),
      action: "show-missing",
    });
  }

  // 2. Warning: unanalyzed
  const unanalyzed = tracks.filter((t) => isUnanalyzed(t, analysisByTrack));
  if (unanalyzed.length > 0) {
    items.push({
      id: "unanalyzed",
      severity: "warning",
      title: `${unanalyzed.length} 曲が未解析です`,
      detail: "BPM / Key / Energy が無いと smooth や harmonic フィルタが効きません。",
      trackIds: unanalyzed.map((t) => t.trackId),
      action: "analyze",
    });
  }

  // 3. Warning: duplicates (trackId or same artist+title)
  const seenIds = new Set<number>();
  const dupIdTracks: number[] = [];
  const seenNameArtist = new Map<string, number>();
  const dupNameTracks: number[] = [];
  for (const t of tracks) {
    if (seenIds.has(t.trackId)) {
      dupIdTracks.push(t.trackId);
    }
    seenIds.add(t.trackId);

    const nak = nameArtistKey(t);
    if (nak !== "::") {
      const prev = seenNameArtist.get(nak);
      if (prev != null) {
        dupNameTracks.push(prev, t.trackId);
      } else {
        seenNameArtist.set(nak, t.trackId);
      }
    }
  }
  const dupIds = [...new Set(dupIdTracks)];
  const dupNames = [...new Set(dupNameTracks)];
  if (dupIds.length > 0 || dupNames.length > 0) {
    const allDup = [...new Set([...dupIds, ...dupNames])];
    const parts: string[] = [];
    if (dupIds.length > 0) parts.push(`同一 ID ${dupIds.length} 曲`);
    if (dupNames.length > 0) parts.push(`同名・同アーティスト ${dupNames.length} 曲`);
    items.push({
      id: "duplicates",
      severity: "warning",
      title: `重複トラックあり`,
      detail: parts.join(" / "),
      trackIds: allDup,
    });
  }

  // 4. Warning: target duration ±10%
  const meta = setMeta ?? DEFAULT_SET_META;
  if (meta.targetDurationMin != null && meta.targetDurationMin > 0) {
    const actualMin = durationMs / 60_000;
    const target = meta.targetDurationMin;
    const ratio = actualMin / target;
    if (ratio > 1.1 || ratio < 0.9) {
      const over = ratio > 1.1;
      items.push({
        id: "duration",
        severity: "warning",
        title: over ? "目標尺を超過しています" : "目標尺に足りません",
        detail: `実尺 ${actualMin.toFixed(1)} 分 / 目標 ${target} 分 (${over ? "+" : ""}${((ratio - 1) * 100).toFixed(0)}%)`,
      });
    }
  }

  // 5. Warning: setLint high-severity (warn), excluding overlaps with above
  if (includeLint && tracks.length > 0) {
    const lintItems = lintSet(tracks, analysisByTrack, meta, anchors);
    const overlapPrefix = [
      "missing-",
      "unanalyzed-",
      "dup-id-",
      "dup-name-",
      "duration-",
    ];
    const composition = lintItems.filter(
      (li) =>
        li.severity === "warn" &&
        !overlapPrefix.some((p) => li.key.startsWith(p)),
    );
    if (composition.length > 0) {
      const trackIds = [
        ...new Set(composition.flatMap((li) => li.trackIds ?? [])),
      ];
      items.push({
        id: "set-lint",
        severity: "warning",
        title: `セット構成の警告 ${composition.length} 件`,
        detail: composition
          .slice(0, 5)
          .map((li) => li.message)
          .join(" · ") +
          (composition.length > 5 ? ` …他 ${composition.length - 5} 件` : ""),
        trackIds: trackIds.length > 0 ? trackIds : undefined,
        action: "dismiss-lint",
      });
    }
  }

  // 6. Auto-export
  if (autoExportEnabled) {
    if (!autoExportPath) {
      items.push({
        id: "auto-export-path",
        severity: "warning",
        title: "自動エクスポート先が未設定",
        detail: "自動保存は ON ですがパスがありません。設定で XML エクスポート先を指定してください。",
        action: "open-export",
      });
    } else {
      items.push({
        id: "auto-export-ok",
        severity: "ready",
        title: "自動エクスポート有効",
        detail: autoExportPath,
      });
    }
  } else {
    items.push({
      id: "auto-export-off",
      severity: "ready",
      title: "自動エクスポートはオフ",
      detail: "ギグ前にライブラリ XML の手動エクスポートを検討してください。",
    });
  }

  // 7. Ready banner when clean
  const status = overallStatus(items);
  if (status === "ready") {
    // 既に auto-export の ready 項目があるので、全体 OK を先頭に
    items.unshift({
      id: "all-ready",
      severity: "ready",
      title: "ギグ準備 OK",
      detail: `${tracks.length} 曲 · ブロッカー / 要確認なし`,
    });
  }

  return {
    status,
    items,
    summary: {
      total: tracks.length,
      missing: missing.length,
      unanalyzed: unanalyzed.length,
      durationMs,
    },
  };
}
