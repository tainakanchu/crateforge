import type { DuplicateHit, ItemAction } from "../types";

/**
 * 取り込み済み検出 (iTunes の「すでにライブラリにあります」相当) の表示と既定動作。
 * CD リッピング (RipDialog) とファイル取り込み (ImportDuplicatesDialog) で共用する。
 */

/** 1 曲分の扱い (置き換えなら対象の既存曲 ID)。 */
export interface DuplicateDecision {
  action: ItemAction;
  replaceTrackId: number | null;
}

/**
 * 表示・置き換え対象に使う一致を選ぶ。Rust 側で確からしい順に並んでいるので
 * 基本は先頭。ただし確からしさが同じ (Weak 以外) なら、ファイルが無い / 壊れている
 * 曲を優先する (置き換えたいのはそちらなので)。
 */
export function primaryHit(hits: DuplicateHit[]): DuplicateHit | null {
  if (hits.length === 0) return null;
  const top = hits[0];
  if (top.kind === "weak") return top;
  return hits.find((h) => h.kind === top.kind && h.health !== "ok") ?? top;
}

/**
 * 既定の扱い: 一致なし → 取り込む / Weak (確証なし) → 取り込む /
 * ファイルあり (Exact・Probable) → スキップ / ファイルなし・破損 → 置き換え。
 */
export function defaultDecision(hits: DuplicateHit[]): DuplicateDecision {
  const h = primaryHit(hits);
  if (!h || h.kind === "weak") return { action: "import", replaceTrackId: null };
  if (h.health === "ok") return { action: "skip", replaceTrackId: null };
  return { action: "replace", replaceTrackId: h.trackId };
}

/** 置き換えを選んだときの対象 (既定は primaryHit)。 */
export function replaceTargetOf(hits: DuplicateHit[]): number | null {
  return primaryHit(hits)?.trackId ?? null;
}

export function healthLabel(h: DuplicateHit): string {
  switch (h.health) {
    case "missing":
      return "取り込み済み・ファイルなし";
    case "broken":
      return "取り込み済み・破損の疑い";
    default:
      return "取り込み済み";
  }
}

/** 確からしさの補足 (Exact は何も付けない)。 */
export function kindHint(h: DuplicateHit): string | null {
  switch (h.kind) {
    case "probable":
      return "別アルバム?";
    case "weak":
      return "要確認";
    default:
      return null;
  }
}

function fmtTime(ms: number | null): string {
  if (!ms || ms <= 0) return "--:--";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** ツールチップ用: 一致した既存曲 (アーティスト / アルバム / 長さ / パス)。 */
export function hitTooltip(hits: DuplicateHit[]): string {
  return hits
    .map((h) => {
      const kind =
        h.kind === "exact" ? "一致" : h.kind === "probable" ? "ほぼ一致 (アルバム違い)" : "確証なし (長さで確認できず)";
      return [
        `${h.name || "(no title)"} — ${h.artist || "(no artist)"}`,
        `アルバム: ${h.album || "-"}  長さ: ${fmtTime(h.totalTimeMs)}  [${kind}]`,
        `${h.locationPath ?? "(パスなし)"}`,
      ].join("\n");
    })
    .join("\n\n");
}

export const ACTION_LABELS: Record<ItemAction, string> = {
  import: "取り込む",
  skip: "スキップ",
  replace: "置き換え",
};
