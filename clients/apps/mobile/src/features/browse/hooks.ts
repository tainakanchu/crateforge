// Browse スライスの React Query フック群。
// 全フックは useConnection().client（接続中のみ非 null）を読み、enabled: !!client。
// queryFn では client のメソッドを使い、AbortSignal を受け取る経路には渡す。

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { type Album, type Artist, type ArtistGrouping, type GenreTagCount, type Playlist, type PlaylistDetail, type SimilarHit, type Track, type TracksQuery, trackArtist, trackAlbumArtist, useConnection, useDownloads, useSettings } from "@crateforge/core";

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

/** 指定アルバムの曲（album が null のときは無効）。disc→track 昇順でソート。 */
export function useAlbumTracks(album: string | null) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[], Error, Track[]>({
    queryKey: ["album-tracks", album],
    enabled: !!client && album != null,
    queryFn: () => client!.listTracks({ album: album!, limit: BROWSE_LIMIT }),
    select: (tracks) =>
      [...tracks].sort(
        (a, b) =>
          (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
          (a.trackNumber ?? 0) - (b.trackNumber ?? 0),
      ),
  });
}

/** アーティスト一覧（クライアント側で全曲から集計）。enabled=false で取得抑止。
 * grouping を引数で上書き可能。省略時はストアの artistGrouping を読む。
 * useCallback で select をメモ化し、grouping 変更時に select 参照が変わって再集計される。
 */
export function useArtists(enabled = true, grouping?: ArtistGrouping) {
  const client = useConnection((s) => s.client);
  // 引数省略時はストアの設定を使う（index.tsx が引数なしで呼ぶため）。
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  const select = useCallback(
    (tracks: Track[]): Artist[] => {
      const nameOf = resolvedGrouping === "albumArtist" ? trackAlbumArtist : trackArtist;
      const map = new Map<string, { trackCount: number; sampleTrackId: number }>();
      for (const t of tracks) {
        const name = nameOf(t);
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
    [resolvedGrouping],
  );
  return useQuery<Track[], Error, Artist[]>({
    queryKey: ["tracks", { limit: BROWSE_LIMIT }],
    enabled: !!client && enabled,
    queryFn: ({ signal }) => client!.listTracks({ limit: BROWSE_LIMIT }, signal),
    select,
  });
}

/** 指定アーティストの曲（artist が null のときは無効）。
 * grouping を引数で上書き可能。省略時はストアの artistGrouping を使う。
 * useCallback で select をメモ化し、grouping/artist 変更時に再フィルタされる。
 */
export function useArtistTracks(artist: string | null, grouping?: ArtistGrouping) {
  const client = useConnection((s) => s.client);
  // 引数省略時はストアから読む。
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  const select = useCallback(
    (tracks: Track[]): Track[] => {
      const nameOf = resolvedGrouping === "albumArtist" ? trackAlbumArtist : trackArtist;
      return tracks.filter((t) => nameOf(t) === artist);
    },
    [artist, resolvedGrouping],
  );
  return useQuery<Track[], Error, Track[]>({
    queryKey: ["tracks", { limit: BROWSE_LIMIT }],
    enabled: !!client && artist != null,
    queryFn: ({ signal }) => client!.listTracks({ limit: BROWSE_LIMIT }, signal),
    select,
  });
}

/** 指定アーティストの曲を album でグルーピングして Album[] を作る。
 * artwork 用の sampleTrackId は、可能なら DL 済みトラックを優先（オフラインでローカルアートを引けるよう）。
 * downloadedIds は DL 済み trackId の集合（オンライン時は空でよい）。
 */
function deriveArtistAlbums(
  tracks: Track[],
  artist: string,
  grouping: ArtistGrouping,
  downloadedIds: Set<number>,
): Album[] {
  const nameOf = grouping === "albumArtist" ? trackAlbumArtist : trackArtist;
  const map = new Map<
    string,
    { album: string; albumArtist: string | null; trackCount: number; sampleTrackId: number; sampleDownloaded: boolean }
  >();
  for (const t of tracks) {
    if (nameOf(t) !== artist) continue;
    const album = t.album ?? "";
    const isDownloaded = downloadedIds.has(t.trackId);
    const entry = map.get(album);
    if (entry) {
      entry.trackCount += 1;
      // 代表トラックは「DL 済み優先」。既存が未 DL で今回が DL 済みなら差し替える。
      if (isDownloaded && !entry.sampleDownloaded) {
        entry.sampleTrackId = t.trackId;
        entry.sampleDownloaded = true;
      }
    } else {
      map.set(album, {
        album,
        albumArtist: t.albumArtist,
        trackCount: 1,
        sampleTrackId: t.trackId,
        sampleDownloaded: isDownloaded,
      });
    }
  }
  return [...map.values()]
    .map(({ album, albumArtist, trackCount, sampleTrackId }) => ({ album, albumArtist, trackCount, sampleTrackId }))
    .sort(
      (a, b) =>
        (a.albumArtist ?? a.album).localeCompare(b.albumArtist ?? b.album, undefined, { sensitivity: "base" }) ||
        a.album.localeCompare(b.album, undefined, { sensitivity: "base" }),
    );
}

/** 指定アーティストのアルバム一覧（album でグルーピング）。
 * オンライン=全曲キャッシュからフィルタ／オフライン（client null）=DL 済み entries からフィルタ。
 * grouping を引数で上書き可能。省略時はストアの artistGrouping を使う。
 * ソートは albumArtist 順（同点は album 名）。
 */
export function useArtistAlbums(artist: string | null, grouping?: ArtistGrouping): Album[] {
  const client = useConnection((s) => s.client);
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  const entries = useDownloads((s) => s.entries);
  // オンライン時のみ全曲キャッシュを使う（select でアルバム集計）。
  const downloadedIds = useMemo(() => new Set(Object.values(entries).map((e) => e.trackId)), [entries]);
  const select = useCallback(
    (tracks: Track[]): Album[] =>
      artist == null ? [] : deriveArtistAlbums(tracks, artist, resolvedGrouping, downloadedIds),
    [artist, resolvedGrouping, downloadedIds],
  );
  const query = useQuery<Track[], Error, Album[]>({
    queryKey: ["tracks", { limit: BROWSE_LIMIT }],
    enabled: !!client && artist != null,
    queryFn: ({ signal }) => client!.listTracks({ limit: BROWSE_LIMIT }, signal),
    select,
  });
  // オフライン（client null）は DL 済みトラックからアルバムを導出。
  const offlineAlbums = useMemo(() => {
    if (client || artist == null) return [] as Album[];
    const tracks = Object.values(entries).map((e) => e.track);
    return deriveArtistAlbums(tracks, artist, resolvedGrouping, downloadedIds);
  }, [client, artist, resolvedGrouping, entries, downloadedIds]);
  return client ? (query.data ?? []) : offlineAlbums;
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
