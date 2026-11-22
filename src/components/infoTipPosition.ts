/**
 * InfoTip (ⓘ) のポップオーバー位置を決める純関数。
 *
 * - 既定はボタンの下。下に収まらず、上の方が広いときは上に反転する。
 * - 横はボタンの左端にそろえ、境界 (ダイアログ枠 ∩ ビューポート) から
 *   はみ出さないよう左右に寄せる。
 * 座標はすべてビューポート基準 (position: fixed 用)。
 */
export interface TipRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TipPlacement {
  top: number;
  left: number;
  placement: "below" | "above";
}

/** ボタンとポップオーバーの間隔 (px)。 */
export const TIP_GAP = 6;
/** 境界の内側に確保する余白 (px)。 */
export const TIP_MARGIN = 8;

export function placeInfoTip(
  anchor: TipRect,
  tip: { width: number; height: number },
  bounds: TipRect,
): TipPlacement {
  const bTop = bounds.top + TIP_MARGIN;
  const bBottom = bounds.top + bounds.height - TIP_MARGIN;
  const bLeft = bounds.left + TIP_MARGIN;
  const bRight = bounds.left + bounds.width - TIP_MARGIN;

  const belowTop = anchor.top + anchor.height + TIP_GAP;
  const aboveTop = anchor.top - TIP_GAP - tip.height;
  const spaceBelow = bBottom - belowTop;
  const spaceAbove = anchor.top - TIP_GAP - bTop;

  let placement: TipPlacement["placement"] = "below";
  if (tip.height > spaceBelow && spaceAbove > spaceBelow) placement = "above";

  let top = placement === "below" ? belowTop : aboveTop;
  // それでも収まらないときは境界内に押し込む (上端を優先して見せる)。
  top = Math.min(top, bBottom - tip.height);
  top = Math.max(top, bTop);

  let left = anchor.left;
  left = Math.min(left, bRight - tip.width);
  left = Math.max(left, bLeft);

  return { top, left, placement };
}

/** 2 つの矩形の共通部分。重ならないときは b を返す (境界が無いよりはまし)。 */
export function intersectRect(a: TipRect, b: TipRect): TipRect {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return b;
  return { left, top, width: right - left, height: bottom - top };
}
