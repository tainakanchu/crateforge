// オフライン編集の衝突判定（純粋関数）。テストしやすくするため I/O から切り離す。

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

/** 衝突表示用にローカル / サーバの星数を要約する。 */
export function formatRatingConflict(
  localRating: number,
  serverRating: number | null,
): { localStars: number; serverStars: number; label: string } {
  const localStars = Math.round(Math.max(0, Math.min(100, localRating)) / 20);
  const serverStars =
    serverRating == null ? 0 : Math.round(Math.max(0, Math.min(100, serverRating)) / 20);
  const localLabel = localStars > 0 ? "★".repeat(localStars) : "未設定";
  const serverLabel = serverStars > 0 ? "★".repeat(serverStars) : "未設定";
  return {
    localStars,
    serverStars,
    label: `端末 ${localLabel} / サーバ ${serverLabel}`,
  };
}
