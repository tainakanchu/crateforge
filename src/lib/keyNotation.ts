// Key 表記の切替 (#172) — 純関数のみ。
//
// 保存値は常に Camelot ("8A") のまま (解析値 track_analysis.key_camelot /
// 手動上書き tracks.key_camelot_user)。ここでは表示用に Open Key / Classic へ
// 変換するだけで、互換判定・並び順は Camelot ホイール基準を崩さない。

import type { Track, TrackAnalysis } from "../types";

/** Key の表示表記。 */
export type KeyNotation = "camelot" | "openkey" | "classic";

export const KEY_NOTATIONS: readonly KeyNotation[] = ["camelot", "openkey", "classic"];

export const KEY_NOTATION_LABELS: Record<KeyNotation, string> = {
  camelot: "Camelot（例: 8A）",
  openkey: "Open Key（例: 1m）",
  classic: "Classic（例: Am）",
};

export function isKeyNotation(v: unknown): v is KeyNotation {
  return v === "camelot" || v === "openkey" || v === "classic";
}

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

// Camelot 番号 (1..=12) ごとのトニック。DJ ソフト (rekordbox 等) の Classic 表記に合わせ、
// 黒鍵は慣用的な綴り (Ab / Eb / Bb / Db / F#) を使う。
const CLASSIC_MINOR = [
  "Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "Dbm",
] as const;
const CLASSIC_MAJOR = [
  "B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E",
] as const;

/** Camelot を正規化する (" 8a " → "8A")。不正なら null。 */
export function normalizeCamelot(s: string | null | undefined): string | null {
  if (!s) return null;
  const p = parseCamelot(s);
  if (!p) return null;
  return `${p.num}${p.isMinor ? "A" : "B"}`;
}

/**
 * Camelot → Open Key。Open Key は C major = 1d / A minor = 1m 起点なので
 * Camelot 番号から 7 ずらす (8A → 1m, 8B → 1d, 1A → 6m)。
 */
export function camelotToOpenKey(camelot: string): string | null {
  const p = parseCamelot(camelot);
  if (!p) return null;
  const n = ((p.num - 8 + 12) % 12) + 1;
  return `${n}${p.isMinor ? "m" : "d"}`;
}

/** Camelot → Classic (音楽表記)。8A → "Am", 8B → "C", 11A → "F#m"。 */
export function camelotToClassic(camelot: string): string | null {
  const p = parseCamelot(camelot);
  if (!p) return null;
  return (p.isMinor ? CLASSIC_MINOR : CLASSIC_MAJOR)[p.num - 1];
}

/**
 * Camelot キーを指定表記で表示用文字列にする。解釈できない値は (大文字化して)
 * そのまま返し、null/空は null。
 */
export function formatKey(
  camelot: string | null | undefined,
  notation: KeyNotation,
): string | null {
  const t = camelot?.trim();
  if (!t) return null;
  const norm = normalizeCamelot(t);
  if (!norm) return t.toUpperCase();
  switch (notation) {
    case "openkey":
      return camelotToOpenKey(norm);
    case "classic":
      return camelotToClassic(norm);
    default:
      return norm;
  }
}

/**
 * Camelot ホイール順の全 24 キー (1A, 1B, 2A, … 12B)。キー選択 UI 用。
 * 表示表記に関係なく並びは Camelot ホイール基準にする。
 */
export const ALL_CAMELOT_KEYS: readonly string[] = Array.from({ length: 24 }, (_, i) =>
  `${Math.floor(i / 2) + 1}${i % 2 === 0 ? "A" : "B"}`,
);

type KeyTrackSlice = Pick<Track, "keyCamelotUser"> | null | undefined;
type KeyAnalysisSlice =
  | Pick<TrackAnalysis, "keyCamelot" | "keyCamelotUser">
  | null
  | undefined;

/**
 * 実効キー (Camelot) = 手動上書き ?? 解析値。
 * 解析行があればそちらの keyCamelotUser (DB で tracks から合成済み・常に最新) を優先し、
 * 未解析の曲だけ Track 側の上書きを見る。
 */
export function effectiveKeyCamelot(
  track: KeyTrackSlice,
  analysis: KeyAnalysisSlice,
): string | null {
  if (analysis) {
    return analysis.keyCamelotUser?.trim() || analysis.keyCamelot?.trim() || null;
  }
  return track?.keyCamelotUser?.trim() || null;
}

/** 実効キーが手動上書きによるものか。 */
export function isKeyOverridden(track: KeyTrackSlice, analysis: KeyAnalysisSlice): boolean {
  if (analysis) return !!analysis.keyCamelotUser?.trim();
  return !!track?.keyCamelotUser?.trim();
}

/** ツールチップ用: 3 表記を並べた説明 ("8A · 1m · Am")。 */
export function describeKey(camelot: string | null | undefined): string | null {
  const norm = normalizeCamelot(camelot);
  if (!norm) return null;
  return [norm, camelotToOpenKey(norm), camelotToClassic(norm)].join(" · ");
}
