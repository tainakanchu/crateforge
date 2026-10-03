// レーティングの変換ヘルパ (#172 半星)。
// DB / iTunes XML / LAN API の rating は 0-100 (iTunes 互換, ★1 = 20)。
// UI は 0.5 星刻み (= rating 10 刻み) で扱う。半端な値 (例: 65) は最寄りの半星に丸める。

/** 0-100 の rating を 0..5 の星 (0.5 刻み) に。null/不正値は 0。 */
export function ratingToStars(rating: number | null | undefined): number {
  if (rating == null || !Number.isFinite(rating)) return 0;
  const clamped = Math.max(0, Math.min(100, rating));
  return Math.round(clamped / 10) / 2;
}

/** 0..5 の星 (0.5 刻み) を 0-100 の rating (10 の倍数) に。 */
export function starsToRating(stars: number): number {
  if (!Number.isFinite(stars)) return 0;
  return Math.max(0, Math.min(100, Math.round(stars * 2) * 10));
}

/** 星数をテキストで表す (例: 3.5 → "★★★½☆")。0 は空文字。 */
export function starsText(stars: number): string {
  if (stars <= 0) return "";
  const full = Math.floor(stars);
  const half = stars - full >= 0.5;
  return "★".repeat(full) + (half ? "½" : "") + "☆".repeat(Math.max(0, 5 - full - (half ? 1 : 0)));
}
