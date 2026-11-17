// 表示用フォーマッタ (純関数。tests/desktop/format.test.ts で固定)。

// 時間表示の規則 (docs/ui-spec.md §3.8):
// - 秒未満は常に切り捨て。
// - 長さ・合計・再生位置のどれも、1 時間未満は `m:ss`、1 時間以上は `h:mm:ss` (規則は 1 つ)。
// 用途で違うのは「値が無いとき」の表示だけ。画面からは用途別の 4 関数を使う。

type Ms = number | null | undefined;

/** 整形できる長さか (正の有限値)。null / 0 以下 / NaN / Infinity は「値なし」。 */
function hasDuration(ms: Ms): ms is number {
  return ms != null && Number.isFinite(ms) && ms > 0;
}

/** `m:ss` (1 時間未満) / `h:mm:ss` (1 時間以上)。値なしは 0 として整形する。 */
function clock(ms: Ms): string {
  const value = hasDuration(ms) ? ms : 0;
  const total = Math.floor(value / 1000);
  const sec = (total % 60).toString().padStart(2, "0");
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}:${m.toString().padStart(2, "0")}:${sec}`;
  }
  return `${Math.floor(total / 60)}:${sec}`;
}

/**
 * 曲 1 曲の長さ。長さが分からない (null / 0 以下 / NaN / Infinity) ときは空文字。
 * ラベル付きの欄で「—」などを出したい画面は `formatTrackTime(ms) || "—"` とする。
 */
export function formatTrackTime(ms: Ms): string {
  return hasDuration(ms) ? clock(ms) : "";
}

/**
 * 合計時間 (アルバム・アーティストのアルバム・Crate・キュー・セット・CD)。
 * 値が無いときは `0:00`。
 */
export function formatTotalTime(ms: Ms): string {
  return clock(ms);
}

/** 再生位置・再生中の曲の長さ (プレイヤーバー)。値が無いときは `0:00`。 */
export function formatPlaybackTime(ms: Ms): string {
  return clock(ms);
}

/** 残り時間 (プレイヤーバー): 先頭に `-` を付ける。曲長を超えた位置は `-0:00`。 */
export function formatRemainingTime(positionMs: number, durationMs: number): string {
  return `-${clock(durationMs - positionMs)}`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** バイト数を 1024 基準の単位で整形する (`0 B` / `12.3 MB`)。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** power;
  const digits = value >= 100 || power === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${BYTE_UNITS[power]}`;
}

/** ローカル時刻の `YYYY-MM-DD`。 */
export function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
