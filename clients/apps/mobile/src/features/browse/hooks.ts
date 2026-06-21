// Browse スライスの React Query フック群。
// 全フックは useConnection().client（接続中のみ非 null）を読み、enabled: !!client。
// queryFn では client のメソッドを使い、AbortSignal を受け取る経路には渡す。

import { useQuery } from "@tanstack/react-query";

import { type Album, type Artist, type GenreTagCount, type Playlist, type PlaylistDetail, type SimilarHit, type Track, type TracksQuery, trackArtist, useConnection } from "@crateforge/core";

/** 大規模ライブラリでも全件取得（仮想リスト前提）。500/200 上限の撤廃。 */
export const BROWSE_LIMIT = 100000;

/** 曲一覧（検索/ジャンル等のクエリで絞り込み）。enabled=false で取得抑止（非表示モード時）。 */
export function useTracks(query?: TracksQuery, enabled = true) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[]>({
    queryKey: ["tracks", query ?? {}],
    enabled: !!client && enabled,
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

/** プレイリスト単体の情報（詳細ヘッダの名前など）。 */
export function usePlaylist(playlistId: number) {
  const client = useConnection((s) => s.client);
  return useQuery<PlaylistDetail>({
    queryKey: ["playlist", playlistId],
    enabled: !!client && Number.isFinite(playlistId),
    queryFn: () => client!.playlist(playlistId),
  });
}

/** プレイリスト内の曲。 */
export function usePlaylistTracks(playlistId: number) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[]>({
    queryKey: ["playlist-tracks", playlistId],
    enabled: !!client,
    queryFn: () => client!.playlistTracks(playlistId, { limit: BROWSE_LIMIT }),
  });
}

/** アルバム一覧（distinct）。enabled=false で取得抑止。 */
export function useAlbums(enabled = true) {
  const client = useConnection((s) => s.client);
  return useQuery<Album[]>({
    queryKey: ["albums"],
    enabled: !!client && enabled,
    queryFn: () => client!.albums(),
  });
}

/** 指定アルバムの曲（album が null のときは無効）。 */
export function useAlbumTracks(album: string | null) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[]>({
    queryKey: ["album-tracks", album],
    enabled: !!client && album != null,
    queryFn: () => client!.listTracks({ album: album!, limit: BROWSE_LIMIT }),
  });
}

/** アーティスト一覧（クライアント側で全曲から集計）。enabled=false で取得抑止。 */
export function useArtists(enabled = true) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[], Error, Artist[]>({
    queryKey: ["tracks", { limit: BROWSE_LIMIT }],
    enabled: !!client && enabled,
    queryFn: ({ signal }) => client!.listTracks({ limit: BROWSE_LIMIT }, signal),
    select: (tracks: Track[]): Artist[] => {
      const map = new Map<string, { trackCount: number; sampleTrackId: number }>();
      for (const t of tracks) {
        const name = trackArtist(t);
        const entry = map.get(name);
        if (entry) {
          entry.trackCount += 1;
        } else {
          map.set(name, { trackCount: 1, sampleTrackId: t.trackId });
        }
      }
      return [...map.entries()]
        .map(([artist, { trackCount, sampleTrackId }]) => ({ artist, trackCount, sampleTrackId }))
        .sort((a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: "base" }));
    },
  });
}

/** 指定アーティストの曲（artist が null のときは無効）。 */
export function useArtistTracks(artist: string | null) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[], Error, Track[]>({
    queryKey: ["tracks", { limit: BROWSE_LIMIT }],
    enabled: !!client && artist != null,
    queryFn: ({ signal }) => client!.listTracks({ limit: BROWSE_LIMIT }, signal),
    select: (tracks: Track[]): Track[] =>
      tracks.filter((t) => trackArtist(t) === artist),
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
