// 表示用の純粋関数群（UI から切り離してテストしやすくする）。

import type { Tag, Track, TrackMetaField } from "./types";

/** first-class Tag の表示文字列。namespace 空なら value のみ、それ以外は `ns:value`。 */
export function formatTag(tag: Pick<Tag, "namespace" | "value">): string {
  if (!tag.namespace) return tag.value;
  return `${tag.namespace}:${tag.value}`;
}

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

/** 0-100 の rating を 0.5 刻み（0..5）の星数に。10 刻みの半星を保持する。 */
export function ratingToHalfStars(rating: number | null | undefined): number {
  if (rating == null || !Number.isFinite(rating)) return 0;
  const clamped = Math.max(0, Math.min(100, rating));
  return Math.round(clamped / 10) / 2;
}

/** 半星対応の星文字列。例: 70 → "★★★½"、80 → "★★★★"、0 → ""。 */
export function formatRatingStars(rating: number | null | undefined): string {
  const half = ratingToHalfStars(rating);
  const full = Math.floor(half);
  return "★".repeat(full) + (half - full >= 0.5 ? "½" : "");
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

/** タグにアーティストが無い曲（グループ）の表示ラベル。 */
export const UNKNOWN_ARTIST_LABEL = "不明なアーティスト";
/** タグにアルバムが無い曲（グループ）の表示ラベル。 */
export const UNKNOWN_ALBUM_LABEL = "不明なアルバム";

/**
 * アーティスト名の表示ラベル。空（null / "" / 空白のみ）は「不明なアーティスト」。
 * `/api/artists` は不明なアーティストを `artist: ""` で返すので、名前を出す所はこれを通す。
 */
export function artistLabel(name: string | null | undefined): string {
  return name && name.trim() ? name : UNKNOWN_ARTIST_LABEL;
}

/**
 * アルバム名の表示ラベル。空（null / "" / 空白のみ）は「不明なアルバム」。
 * `/api/albums` は不明なアルバムを `album: ""` で返す。
 */
export function albumLabel(name: string | null | undefined): string {
  return name && name.trim() ? name : UNKNOWN_ALBUM_LABEL;
}

/**
 * 曲のアーティストの束ねキー（grouping=artist）。`/api/artists` の `artist` と同じ規則:
 * artist || albumArtist || ""（空 = 不明なアーティスト）。オフラインでの絞り込みや
 * `/api/tracks?artist=` との突き合わせに使う（表示には trackArtist を使う）。
 */
export function trackArtistKey(t: Pick<Track, "artist" | "albumArtist">): string {
  return t.artist || t.albumArtist || "";
}

/** 曲のアルバムアーティストの束ねキー（grouping=albumArtist）: albumArtist || artist || ""。 */
export function trackAlbumArtistKey(t: Pick<Track, "artist" | "albumArtist">): string {
  return t.albumArtist || t.artist || "";
}

/** 曲の表示アーティスト。無ければ「不明なアーティスト」。 */
export function trackArtist(t: Pick<Track, "artist" | "albumArtist">): string {
  return artistLabel(trackArtistKey(t));
}

/** アルバムアーティスト名。無ければトラックのアーティスト、それも無ければ「不明なアーティスト」。 */
export function trackAlbumArtist(t: Pick<Track, "artist" | "albumArtist">): string {
  return artistLabel(trackAlbumArtistKey(t));
}

/** "Artist — Album" 形式のサブタイトル（欠損は片側のみ）。 */
export function trackSubtitle(t: Pick<Track, "artist" | "albumArtist" | "album">): string {
  const artist = t.artist || t.albumArtist || "";
  const album = t.album || "";
  if (artist && album) return `${artist} — ${album}`;
  return artist || album || UNKNOWN_ARTIST_LABEL;
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
      const text = formatRatingStars(track.rating);
      return text !== "" ? text : null;
    }
    case "playCount":
      return track.playCount != null && track.playCount > 0
        ? `▶ ${track.playCount}`
        : null;
  }
}
