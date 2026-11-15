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
 * 整形の中核。画面からは下の用途別の関数 (formatTrackTime など) を使う。
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

// ---- 用途別の時間表示 ----
// 丸め・時の有無・値なしの表示が用途ごとに違うのは現状どおり (tests/desktop/format.test.ts で固定)。
// 揃えるのはフェーズ 2 (A2)。呼び出し元は formatClock を直接使わず、ここの関数を使う。

type Ms = number | null | undefined;

/** 曲の長さ (TrackTable の Time 列・AlbumsView の曲行): `m:ss`、切り捨て、値なしは空。 */
export const formatTrackTime = (ms: Ms): string => formatClock(ms, { empty: "" });

/** アルバムの合計時間 (AlbumsView の展開ヘッダー): `m:ss` (時を付けない)、切り捨て、値なしは空。 */
export const formatAlbumTotal = (ms: Ms): string => formatClock(ms, { empty: "" });

/**
 * ArtistsView のアルバム合計時間と曲の長さ: 1 時間以上は `h:mm:ss`、切り捨て、値なしは空。
 */
export const formatArtistViewTime = (ms: Ms): string =>
  formatClock(ms, { hours: true, empty: "" });

/** プレイヤーバーの再生位置・曲長: `m:ss`、切り捨て、値なしは `0:00`。 */
export const formatPlaybackTime = (ms: Ms): string => formatClock(ms);

/** プレイヤーバーの残り時間: `-m:ss` (曲長を超えた位置は `-0:00`)。 */
export const formatRemainingTime = (positionMs: number, durationMs: number): string =>
  `-${formatClock(Math.max(0, durationMs - positionMs))}`;

/** Crate / キューの合計時間 (RightRail): `m:ss` (時を付けない)、切り捨て、空なら `0:00`。 */
export const formatListTotal = (ms: Ms): string => formatClock(ms);

/** トリアージパネルの曲長: `m:ss`、切り捨て、値なしは `—`。 */
export const formatTriageDuration = (ms: Ms): string => formatClock(ms, { empty: "—" });

/** 重複確認 (取り込み・リップ) の曲長: `m:ss`、四捨五入、値なしは `--:--`。 */
export const formatDuplicateLength = (ms: Ms): string =>
  formatClock(ms, { empty: "--:--", round: "round" });

/** Get Info の「長さ」: 1 時間以上は `h:mm:ss`、四捨五入、値なしは `—`。 */
export const formatInfoDuration = (ms: Ms): string =>
  formatClock(ms, { hours: true, empty: "—", round: "round" });

/** セット (Gig Readiness) の合計時間: 1 時間以上は `h:mm:ss`、切り捨て、値なしは `0:00`。 */
export const formatSetDuration = (ms: Ms): string => formatClock(ms, { hours: true });

/** CD の合計時間 (秒で受ける): 1 時間以上は `h:mm:ss`、四捨五入。 */
export const formatDiscTotal = (sec: number): string =>
  formatClock(sec * 1000, { hours: true, round: "round" });

/** CD のトラック長 (整数秒で受ける): `m:ss`。 */
export const formatDiscTrackLength = (sec: number): string => formatClock(sec * 1000);

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
