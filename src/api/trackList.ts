// 曲の一覧 (TrackListQuery) を Tauri コマンドへ振り分ける。ページ・件数・ID 列は同じ一覧を指す
// (Rust 側で同じ WHERE 句を通す。docs/library-list/design.md §3)。
import * as libraryApi from "./library";
import * as playlistsApi from "./playlists";
import type { Track } from "../types";
import type { TrackListQuery } from "../lib/trackListQuery";

/** サーバから取る一覧 (ライブラリ / 検索 / プレイリスト)。 */
export type ServerTrackListQuery = Extract<TrackListQuery, { kind: "library" | "playlist" }>;

export function isServerTrackList(q: TrackListQuery): q is ServerTrackListQuery {
  return q.kind === "library" || q.kind === "playlist";
}

/** 一覧の offset から limit 件。 */
export function fetchTrackPage(
  q: ServerTrackListQuery,
  offset: number,
  limit: number,
): Promise<Track[]> {
  if (q.kind === "playlist") {
    const fetch = q.smart ? playlistsApi.getSmartPlaylistTracks : playlistsApi.getPlaylistTracks;
    return fetch(q.playlistId, limit, offset, q.sortField, q.sortOrder, q.query || undefined);
  }
  return q.query
    ? libraryApi.searchTracks(q.query, limit, offset, q.sortField, q.sortOrder)
    : libraryApi.getTracks(limit, offset, q.sortField, q.sortOrder);
}

/** 一覧の全件数。 */
export function fetchTrackCount(q: ServerTrackListQuery): Promise<number> {
  return q.kind === "playlist"
    ? playlistsApi.countPlaylistTracks(q.playlistId, q.query)
    : libraryApi.countTracks(q.query);
}

/**
 * 一覧の trackId を表示順で返す。only を渡すと、そのうち一覧に入っている ID だけ
 * (選択中の曲が一覧に残っているかの確認・選択を表示順に並べる用。数曲のために全件を取らない)。
 */
export function fetchTrackIds(
  q: ServerTrackListQuery,
  only?: readonly number[],
): Promise<number[]> {
  return q.kind === "playlist"
    ? playlistsApi.getPlaylistTrackIds(q.playlistId, q.query, q.sortField, q.sortOrder, only)
    : libraryApi.getTrackIds(q.query, q.sortField, q.sortOrder, only);
}

/**
 * trackId 列を一覧 q の表示順に並べ、曲に解決する (一覧に無い ID は末尾)。
 * 一覧を持たない場所 (ショートカット) から、選択中の曲を右クリックメニューと同じ順で扱うためのもの。
 * memoryTracks はメモリ上の一覧 (Inbox / 最近) の曲。
 */
export async function tracksInListOrder(
  q: TrackListQuery,
  memoryTracks: readonly Track[],
  ids: readonly number[],
): Promise<Track[]> {
  let inList: number[];
  if (isServerTrackList(q)) {
    inList = ids.length > 1 ? await fetchTrackIds(q, ids) : [...ids];
  } else {
    const wanted = new Set(ids);
    inList = memoryTracks.map((t) => t.trackId).filter((id) => wanted.delete(id));
  }
  const rest = new Set(ids);
  for (const id of inList) rest.delete(id);
  return libraryApi.getTracksByIds([...inList, ...rest]);
}
