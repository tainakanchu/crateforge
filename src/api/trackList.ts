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

/** 一覧の trackId を表示順で全件。 */
export function fetchTrackIds(q: ServerTrackListQuery): Promise<number[]> {
  return q.kind === "playlist"
    ? playlistsApi.getPlaylistTrackIds(q.playlistId, q.query, q.sortField, q.sortOrder)
    : libraryApi.getTrackIds(q.query, q.sortField, q.sortOrder);
}
