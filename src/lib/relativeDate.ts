import type { SmartOp } from "../types";

/// スマートプレイリストの相対日付 (`inLast` / `notInLast`) の値。
/// バックエンド (src-tauri/src/smart.rs `parse_relative_date`) と同じ形式: 正の整数 + 単位
/// (`d` 日 / `w` 週 / `m` か月)。例: `"30d"` / `"2w"` / `"3m"`。

export type RelativeUnit = "d" | "w" | "m";

export interface RelativeDate {
  count: number;
  unit: RelativeUnit;
}

export const RELATIVE_UNITS: { value: RelativeUnit; label: string }[] = [
  { value: "d", label: "日" },
  { value: "w", label: "週" },
  { value: "m", label: "か月" },
];

/// 相対日付の演算子を選んだときの既定値 (過去 30 日)。
export const DEFAULT_RELATIVE_VALUE = "30d";

export function isRelativeDateOp(op: SmartOp): boolean {
  return op === "inLast" || op === "notInLast";
}

/// `"30d"` → `{ count: 30, unit: "d" }`。読めない値 (0・小数・単位なし など) は null。
export function parseRelativeDate(value: string): RelativeDate | null {
  const m = /^(\d+)([dwm])$/i.exec(value.trim());
  if (!m) return null;
  const count = Number(m[1]);
  if (!Number.isSafeInteger(count) || count <= 0 || count > 0xffffffff) return null;
  return { count, unit: m[2].toLowerCase() as RelativeUnit };
}

/// 編集中の数値欄 (文字列) と単位から値を作る。数値欄が空・不正でも単位は保つ
/// (保存時に [`parseRelativeDate`] で弾く)。
export function formatRelativeDate(count: string | number, unit: RelativeUnit): string {
  return `${String(count).trim()}${unit}`;
}

/// 値から単位だけを取り出す (読めなければ日)。数値欄が空の途中状態でも単位を保つため。
export function relativeUnitOf(value: string): RelativeUnit {
  const u = value.trim().slice(-1).toLowerCase();
  return u === "w" || u === "m" ? u : "d";
}

/// 値から数値欄の文字列を取り出す (単位を除いた部分)。
export function relativeCountOf(value: string): string {
  const v = value.trim();
  return /[dwm]$/i.test(v) ? v.slice(0, -1) : v;
}

/// 演算子を変えたときの値。相対日付とそれ以外を行き来するときは値の意味が変わるので
/// 既定値 / 空にし、同じ種類の中では保つ。
export function valueForOpChange(prevOp: SmartOp, nextOp: SmartOp, value: string): string {
  const prevRel = isRelativeDateOp(prevOp);
  const nextRel = isRelativeDateOp(nextOp);
  if (prevRel === nextRel) return value;
  return nextRel ? DEFAULT_RELATIVE_VALUE : "";
}
