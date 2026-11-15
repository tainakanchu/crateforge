// オフライン編集の衝突判定（純粋関数）。テストしやすくするため I/O から切り離す。

import { ratingToHalfStars } from "@crateforge/core";

import { ratingLabel } from "./labels";

/**
 * レーティング pending op をサーバ現在値と突き合わせた結果。
 * - apply: base と一致 or 既に目的値 → setRating してよい（冪等）
 * - conflict: サーバ側が base とも op とも違う値に変わっている → 黙って上書きしない
 */
export type RatingResolve = "apply" | "conflict";

/**
 * @param current サーバ上の現在 rating（null = 未設定）
 * @param baseRating 編集開始時に見ていた rating（null = 未設定）
 * @param opRating 端末が書きたい rating（0..100）
 */
export function resolveRatingConflict(
  current: number | null | undefined,
  baseRating: number | null | undefined,
  opRating: number,
): RatingResolve {
  const cur = current ?? null;
  const base = baseRating ?? null;
  // サーバが編集時と同じ、または既に目的値なら適用（冪等）。
  if (cur === base || cur === opRating) return "apply";
  return "conflict";
}

/**
 * 衝突表示用にローカル / サーバの星数を要約する。
 * 星数は core の半星規則（10 刻み = 0.5 星）。例: 70 → 3.5 / "★★★½"。表記は labels.ts の ratingLabel。
 */
export function formatRatingConflict(
  localRating: number,
  serverRating: number | null,
): { localStars: number; serverStars: number; label: string } {
  return {
    localStars: ratingToHalfStars(localRating),
    serverStars: ratingToHalfStars(serverRating),
    label: `端末 ${ratingLabel(localRating)} / サーバ ${ratingLabel(serverRating)}`,
  };
}
