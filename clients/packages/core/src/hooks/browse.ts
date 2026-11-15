// ライブラリ閲覧（読み取り専用）の React Query フック群。mobile / TV の画面から共有する。
// 全フックは useConnection().client（接続中のみ非 null）を読み、未接続なら取得しない。
//
// - queryKey は browseKeys で作る（画面・無効化・キャッシュ参照で同じキーを使うため）。
// - staleTime はここでは決めない。各アプリの QueryClient の既定（mobile 1 分 / TV 5 分）に従う。
//   例外は「絞り込み無しの全曲取得」だけ（UNFILTERED_TRACKS_STALE_MS）。
// - 並び順を変える select や、書き込み（評価・タグ）・オフライン時の導出は各アプリ側。

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { filterAlbumTracks } from "../lib/album";
import { byDiscTrack } from "../lib/sort";
import type { Album, Artist, ArtistGrouping, Playlist, Track, TracksQuery } from "../lib/types";
import { useConnection } from "../store/connection";
import { useSettings } from "../store/settings";

/** 大規模ライブラリでも全件取得（仮想リスト前提）。500/200 上限の撤廃。 */
export const BROWSE_LIMIT = 100000;

/** 絞り込み無しの全曲取得（数万件）をフォーカス/前面復帰のたびに取り直さないための staleTime。 */
export const UNFILTERED_TRACKS_STALE_MS = 5 * 60 * 1000;

/**
 * 閲覧系クエリの queryKey。先頭要素（"tracks" など）だけの配列は前方一致の無効化・再取得に使う。
 * 既存のキャッシュ（mobile はディスクにも永続化）と同じ形を保つこと。
 */
export const browseKeys = {
  /** 曲一覧の全クエリ（前方一致用）。 */
  tracksRoot: ["tracks"] as const,
  /** 曲一覧（検索・ジャンル・並び順ごと）。 */
  tracks: (query?: TracksQuery) => ["tracks", query ?? {}] as const,
  genres: ["genres"] as const,
  playlists: ["playlists"] as const,
  playlist: (playlistId: number) => ["playlist", playlistId] as const,
  playlistTracksRoot: ["playlist-tracks"] as const,
  playlistTracks: (playlistId: number | null | undefined) => ["playlist-tracks", playlistId] as const,
  albums: ["albums"] as const,
  albumTracksRoot: ["album-tracks"] as const,
  albumTracks: (album: string | null) => ["album-tracks", album] as const,
  /** アーティスト一覧の全クエリ（grouping 違いを含む。前方一致用）。 */
  artistsRoot: ["artists"] as const,
  artists: (grouping: ArtistGrouping) => ["artists", grouping] as const,
  artistTracksRoot: ["artist-tracks"] as const,
  artistTracks: (grouping: ArtistGrouping, artist: string | null) =>
    ["artist-tracks", grouping, artist] as const,
  similarRoot: ["similar"] as const,
  similar: (trackId: number | null) => ["similar", trackId] as const,
};

/**
 * 曲一覧（検索/ジャンル等のクエリで絞り込み）。enabled=false で取得抑止（非表示モード・検索語なし）。
 * placeholderData: keepPreviousData で検索/ソート/モード変更時のスピナー点滅を抑える。
 */
export function useTracks(query?: TracksQuery, enabled = true) {
  const client = useConnection((s) => s.client);
  // 絞り込み無しの全曲取得は重い（数万件）ので、フォーカス/前面復帰のたびに取り直さないよう
  // staleTime を長めにする。最新化はプル更新で行える。
  const unfiltered = !query?.q && !query?.genre;
  return useQuery<Track[]>({
    queryKey: browseKeys.tracks(query),
    enabled: !!client && enabled,
    queryFn: ({ signal }) => client!.listTracks(query, signal),
    placeholderData: keepPreviousData,
    // undefined を渡すと既定（QueryClient の staleTime）を上書きしてしまうので、指定時だけ載せる。
    ...(unfiltered ? { staleTime: UNFILTERED_TRACKS_STALE_MS } : {}),
  });
}

/** プレイリスト一覧（フォルダ含むフラットな全件。階層は lib/playlistTree で組む）。 */
export function usePlaylists() {
  const client = useConnection((s) => s.client);
  return useQuery<Playlist[]>({
    queryKey: browseKeys.playlists,
    enabled: !!client,
    queryFn: () => client!.playlists(),
  });
}

/** プレイリスト内の曲（playlistId が null/undefined のときは無効）。 */
export function usePlaylistTracks(playlistId: number | null | undefined) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[]>({
    queryKey: browseKeys.playlistTracks(playlistId),
    enabled: !!client && playlistId != null,
    queryFn: () => client!.playlistTracks(playlistId!, { limit: BROWSE_LIMIT }),
  });
}

/**
 * アルバム一覧（distinct）。enabled=false で取得抑止。
 * 並びは API の返した順。並べ替えは各アプリが select で行う（mobile と TV で並び順が違う）。
 * placeholderData: keepPreviousData で grouping/検索変更時のスピナー点滅を抑える。
 */
export function useAlbums(options?: { enabled?: boolean; select?: (albums: Album[]) => Album[] }) {
  const client = useConnection((s) => s.client);
  return useQuery<Album[], Error, Album[]>({
    queryKey: browseKeys.albums,
    enabled: !!client && (options?.enabled ?? true),
    queryFn: () => client!.albums(),
    placeholderData: keepPreviousData,
    select: options?.select,
  });
}

/**
 * 指定アルバムの曲（album が null のときは無効）。disc→track 昇順でソート。
 * album 名は完全一致（`?album=` は部分一致なので "Dawn" が "Dawn (Remixes)" を含んでしまう）。
 * 新しいホストには albumExact=true で絞らせ、古いホスト向けにクライアントでも完全一致で絞る。
 * albumArtist では絞らない: アルバム一覧（/api/albums）が album 名単位の集計なので、詳細も同じ粒度にする
 * （コンピ/DJ ミックスで album_artist が曲ごとに違っても全曲出す。round-2 M1）。
 * 不明なアルバム（album: ""）も albumExact で album が空の曲を引ける。
 *
 * keepPrevious=true で、別のアルバムへ切り替えた直後に前の結果を仮表示する
 * （TV の master/detail 用。mobile はアルバムごとに画面が変わるので使わない）。
 */
export function useAlbumTracks(album: string | null, options?: { keepPrevious?: boolean }) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[], Error, Track[]>({
    queryKey: browseKeys.albumTracks(album),
    enabled: !!client && album != null,
    queryFn: ({ signal }) =>
      client!.listTracks({ album: album!, albumExact: true, limit: BROWSE_LIMIT }, signal),
    ...(options?.keepPrevious ? { placeholderData: keepPreviousData } : {}),
    select: (tracks) => filterAlbumTracks(tracks, album ?? "").sort(byDiscTrack),
  });
}

/**
 * アーティスト一覧（サーバ側 /api/artists で集計）。enabled=false で取得抑止。
 * grouping を引数で上書き可能。省略時は設定ストアの artistGrouping を読む。
 * キーを ["artists", grouping] にして、grouping ごとにキャッシュする。
 * placeholderData: keepPreviousData で grouping 切替時のスピナー点滅を抑える。
 */
export function useArtists(enabled = true, grouping?: ArtistGrouping) {
  const client = useConnection((s) => s.client);
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  return useQuery<Artist[]>({
    queryKey: browseKeys.artists(resolvedGrouping),
    enabled: !!client && enabled,
    queryFn: () => client!.artists(resolvedGrouping),
    placeholderData: keepPreviousData,
  });
}

/** アーティストの曲を引く listTracks のクエリ（grouping に応じて artist / albumArtist で絞る）。 */
export function artistTracksQuery(artist: string, grouping: ArtistGrouping): TracksQuery {
  return grouping === "albumArtist"
    ? { albumArtist: artist, limit: BROWSE_LIMIT }
    : { artist, limit: BROWSE_LIMIT };
}

/**
 * 指定アーティストの曲（artist が null のときは無効）。
 * grouping を引数で上書き可能。省略時は設定ストアの artistGrouping を使う。
 * サーバ側 artist/albumArtist フィルタで取得するため全曲転送を回避する。
 * 不明なアーティスト（artist: ""）も ?artist=（空）で引ける。
 * placeholderData: keepPreviousData でアーティスト切替時のスピナー点滅を抑える。
 */
export function useArtistTracks(artist: string | null, grouping?: ArtistGrouping) {
  const client = useConnection((s) => s.client);
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  return useQuery<Track[]>({
    queryKey: browseKeys.artistTracks(resolvedGrouping, artist),
    enabled: !!client && artist != null,
    queryFn: ({ signal }) => client!.listTracks(artistTracksQuery(artist!, resolvedGrouping), signal),
    placeholderData: keepPreviousData,
  });
}
