// 一覧の並び順比較（純関数）。mobile / TV の画面と browse フックから共有する。
// どの画面でどの比較を使うか（＝並び順そのもの）は各アプリ側が決める。

import { naturalCompare } from "./search";
import type { Track } from "./types";

/**
 * 名前の自然順比較。ただし空名（不明なアルバム / アーティスト）は常に末尾に置く
 * （デスクトップの Artists / Albums と同じ並び）。
 */
export function compareNamesUnknownLast<T>(nameOf: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const an = nameOf(a).trim();
    const bn = nameOf(b).trim();
    if (!an !== !bn) return an ? -1 : 1;
    return naturalCompare(nameOf(a), nameOf(b));
  };
}

/** アルバム並べ替えに必要な最小キー。year は代表年（MIN 推奨, 無ければ null）。 */
export type AlbumSortKey = { album: string; albumArtist: string | null; year?: number | null };

/**
 * アルバムの共通ソート比較。順序は「アルバムアーティスト → アルバム名 → 年(昇順)」。
 * - 名前比較は localeCompare（base sensitivity）。読み仮名フィールドが無いため漢字は
 *   文字コード順になり得るが許容（簡易ソート）。ロケールは undefined（Hermes 互換重視）。
 * - year は MIN(year) を想定。null/undefined は「年不明」として最後に置く。
 */
export function compareAlbums(a: AlbumSortKey, b: AlbumSortKey): number {
  const byArtist = (a.albumArtist ?? a.album).localeCompare(
    b.albumArtist ?? b.album,
    undefined,
    { sensitivity: "base" },
  );
  if (byArtist !== 0) return byArtist;
  const byAlbum = a.album.localeCompare(b.album, undefined, { sensitivity: "base" });
  if (byAlbum !== 0) return byAlbum;
  // 年順（昇順）。不明（null/undefined）は最後。
  const ay = a.year ?? null;
  const by = b.year ?? null;
  if (ay == null && by == null) return 0;
  if (ay == null) return 1;
  if (by == null) return -1;
  return ay - by;
}

/**
 * アルバム一覧（mobile / TV 共通）の並び順。名前の自然順（不明なアルバムは末尾）で、
 * 同名のアルバムどうしは compareAlbums（アルバムアーティスト → アルバム名 → 年）で決める。
 */
export const compareAlbumsByName: (a: AlbumSortKey, b: AlbumSortKey) => number = (() => {
  const byName = compareNamesUnknownLast((a: AlbumSortKey) => a.album);
  return (a, b) => byName(a, b) || compareAlbums(a, b);
})();

/** disc 番号 → トラック番号 の収録順比較（番号なしは 0 扱い）。 */
export function byDiscTrack(
  a: Pick<Track, "discNumber" | "trackNumber">,
  b: Pick<Track, "discNumber" | "trackNumber">,
): number {
  return (a.discNumber ?? 0) - (b.discNumber ?? 0) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0);
}
