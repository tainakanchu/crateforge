// 表示用の純粋関数群（UI から切り離してテストしやすくする）。

import type { Track, TrackMetaField } from "./types";

/** ミリ秒を mm:ss / h:mm:ss に整形。null/負値は "0:00"。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hr = Math.floor(totalSec / 3600);
  const ss = String(sec).padStart(2, "0");
  if (hr > 0) {
    const mm = String(min).padStart(2, "0");
    return `${hr}:${mm}:${ss}`;
  }
  return `${min}:${ss}`;
}

/** 秒（小数可）を mm:ss に整形。expo-audio は秒単位なので使う。 */
export function formatSeconds(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "0:00";
  return formatDuration(Math.round(sec * 1000));
}

/** 0-100 の rating を 0-5 の星（半端は四捨五入で 0.5 刻みに丸めず整数星）に。 */
export function ratingToStars(rating: number | null | undefined): number {
  if (rating == null || !Number.isFinite(rating)) return 0;
  const clamped = Math.max(0, Math.min(100, rating));
  return Math.round(clamped / 20);
}

/** 曲の表示タイトル。name 無しはファイル名 or "Unknown"。 */
export function trackTitle(t: Pick<Track, "name" | "locationPath">): string {
  if (t.name && t.name.trim() !== "") return t.name;
  if (t.locationPath) {
    const base = t.locationPath.split(/[/\\]/).pop();
    if (base) return base;
  }
  return "Unknown Track";
}

/** 曲の表示アーティスト。 */
export function trackArtist(t: Pick<Track, "artist" | "albumArtist">): string {
  return t.artist || t.albumArtist || "Unknown Artist";
}

/** "Artist — Album" 形式のサブタイトル（欠損は片側のみ）。 */
export function trackSubtitle(t: Pick<Track, "artist" | "albumArtist" | "album">): string {
  const artist = t.artist || t.albumArtist || "";
  const album = t.album || "";
  if (artist && album) return `${artist} — ${album}`;
  return artist || album || "Unknown Artist";
}

/** 指定フィールドのメタテキストを生成する。値がない場合は null を返す。 */
export function trackMetaText(
  track: Pick<Track, "bpm" | "year" | "genre" | "rating" | "playCount">,
  field: TrackMetaField,
): string | null {
  switch (field) {
    case "bpm":
      return track.bpm != null ? `${track.bpm} BPM` : null;
    case "year":
      return track.year != null ? `${track.year}` : null;
    case "genre":
      return track.genre || null;
    case "rating": {
      const stars = ratingToStars(track.rating);
      return stars > 0 ? "★".repeat(stars) : null;
    }
    case "playCount":
      return track.playCount != null && track.playCount > 0
        ? `▶ ${track.playCount}`
        : null;
  }
}
