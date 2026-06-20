// Browse スライスの React Query フック群。
// 全フックは useConnection().client（接続中のみ非 null）を読み、enabled: !!client。
// queryFn では client のメソッドを使い、AbortSignal を受け取る経路には渡す。

import { useQuery } from "@tanstack/react-query";

import type {
  GenreTagCount,
  Playlist,
  SimilarHit,
  Track,
  TracksQuery,
} from "@/lib/types";
import { useConnection } from "@/store/connection";

/** 曲一覧（検索/ジャンル等のクエリで絞り込み）。 */
export function useTracks(query?: TracksQuery) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[]>({
    queryKey: ["tracks", query ?? {}],
    enabled: !!client,
    queryFn: ({ signal }) => client!.listTracks(query, signal),
  });
}

/** ジャンルタグの頻度一覧（チップ用）。 */
export function useGenres() {
  const client = useConnection((s) => s.client);
  return useQuery<GenreTagCount[]>({
    queryKey: ["genres"],
    enabled: !!client,
    queryFn: () => client!.genres(),
  });
}

/** プレイリスト一覧（UI 側でフォルダを除外できる）。 */
export function usePlaylists() {
  const client = useConnection((s) => s.client);
  return useQuery<Playlist[]>({
    queryKey: ["playlists"],
    enabled: !!client,
    queryFn: () => client!.playlists(),
  });
}

/** プレイリスト内の曲。 */
export function usePlaylistTracks(playlistId: number) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[]>({
    queryKey: ["playlist-tracks", playlistId],
    enabled: !!client,
    queryFn: () => client!.playlistTracks(playlistId),
  });
}

/** 類似曲（trackId が null のときは無効）。 */
export function useSimilar(trackId: number | null) {
  const client = useConnection((s) => s.client);
  return useQuery<SimilarHit[]>({
    queryKey: ["similar", trackId],
    enabled: !!client && trackId != null,
    queryFn: () => client!.similar(trackId!),
  });
}
