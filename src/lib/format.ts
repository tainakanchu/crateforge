// 表示用フォーマッタ (純関数。tests/desktop/format.test.ts で固定)。

export interface ClockOptions {
  /** true なら 1 時間以上を `h:mm:ss` にする。false (既定) は分を繰り上げない (`75:03`)。 */
  hours?: boolean;
  /**
   * 値が無い (null / undefined / 0 以下 / NaN) ときに返す文字列。
   * 省略時は 0 として整形する (`0:00`)。
   */
  empty?: string;
  /** 秒への丸め。既定は切り捨て。 */
  round?: "floor" | "round";
}

/**
 * ミリ秒を `m:ss` / `h:mm:ss` に整形する。
 *
 * 丸め・時の有無・空表示は呼び出し元ごとに違う (現状の表示を保つためオプションで受ける)。
 * 表示の統一は docs/refactor/design.md フェーズ 2 (A2)。
 */
export function formatClock(ms: number | null | undefined, opts: ClockOptions = {}): string {
  const { hours = false, empty, round = "floor" } = opts;
  let value = ms ?? 0;
  if (!(value > 0)) {
    if (empty !== undefined) return empty;
    value = 0;
  }
  const total = round === "round" ? Math.round(value / 1000) : Math.floor(value / 1000);
  const sec = (total % 60).toString().padStart(2, "0");
  if (hours && total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}:${m.toString().padStart(2, "0")}:${sec}`;
  }
  return `${Math.floor(total / 60)}:${sec}`;
}

/** バイト数を 1024 基準の単位で整形する (`0 B` / `12.3 MB`)。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  const digits = value >= 100 || power === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[power]}`;
}

/** ローカル時刻の `YYYY-MM-DD`。 */
export function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
