// 保留中の編集・衝突を一覧に出すときの文言（純粋関数）。

import { formatRatingStars } from "@crateforge/core";

import type { PendingOp } from "@/store/pendingEdits";

/**
 * 評価の表示。曲行・長押しメニューと同じ core の formatRatingStars（★ の個数 + 半星は ½）を使う。
 * 例: 100 → "★★★★★"、70 → "★★★½"、10 → "½"。0 / 未設定は "未設定"。
 */
export function ratingLabel(rating: number | null | undefined): string {
  return formatRatingStars(rating) || "未設定";
}

/** 保留中の編集 1 件の要約（設定画面の「同期待ち」一覧）。 */
export function describePendingOp(op: PendingOp): string {
  const name = op.trackName || `#${op.trackId}`;
  switch (op.kind) {
    case "rating":
      return `${ratingLabel(op.rating)} ← ${name}`;
    case "tag-add":
      return `+${op.tag} ← ${name}`;
    case "tag-remove":
      return `-${op.tag} ← ${name}`;
    case "review-later":
      return `あとで ← ${name}`;
  }
}
