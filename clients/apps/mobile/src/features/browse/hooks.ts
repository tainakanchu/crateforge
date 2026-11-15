// Browse スライスの React Query フック群（mobile 固有分）。
// 読み取りの共通フック（usePlaylists / usePlaylistTracks / useAlbumTracks / useArtists /
// useArtistTracks）は core/src/hooks/browse.ts にあり、ここから再エクスポートする。
// useTracks / useAlbums は core のフックに mobile の staleTime・並び順を足した薄いラッパ。
// ここに残すのは mobile だけが使うもの: アルバムの並び順、オフライン（DL 済み）からの導出、書き込み。
// 全フックは useConnection().client（接続中のみ非 null）を読み、enabled: !!client。

import { useCallback, useMemo } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type Album,
  type ArtistGrouping,
  type GenreTagCount,
  type PlaylistDetail,
  type SimilarHit,
  type Track,
  type TracksQuery,
  BROWSE_LIMIT,
  artistTracksQuery,
  browseKeys,
  compareAlbums,
  trackArtistKey,
  trackAlbumArtistKey,
  useAlbums as useAlbumsUnsorted,
  useTracks as useTracksQuery,
  useConnection,
  useDownloads,
  useSettings,
} from "@crateforge/core";

import { type RatingEdit, invalidateRatingQueries, writeRating } from "@/features/triage/edits";

export {
  BROWSE_LIMIT,
  useAlbumTracks,
  useArtistTracks,
  useArtists,
  usePlaylistTracks,
  usePlaylists,
} from "@crateforge/core";

/** 絞り込み無しの全曲取得（数万件）をフォーカス/前面復帰のたびに取り直さないための staleTime。 */
export const UNFILTERED_TRACKS_STALE_MS = 5 * 60 * 1000;

/**
 * 曲一覧（core の useTracks）。絞り込み無しの全曲取得は重いので、mobile の既定（1 分）より
 * 長い staleTime にする。検索・ジャンル絞り込みは既定のまま。最新化はプル更新で行える。
 */
export function useTracks(query?: TracksQuery, options?: { enabled?: boolean }) {
  const unfiltered = !query?.q && !query?.genre;
  return useTracksQuery(query, {
    enabled: options?.enabled,
    ...(unfiltered ? { staleTime: UNFILTERED_TRACKS_STALE_MS } : {}),
  });
}

/** トラック配列から「アルバム名 → 代表年(MIN)」のマップを作る（year を持つ曲のみ集計）。 */
export function albumYearMap(tracks: Track[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tracks) {
    if (t.year == null) continue;
    const key = t.album ?? "";
    const prev = map.get(key);
    if (prev == null || t.year < prev) map.set(key, t.year);
  }
  return map;
}

/** ジャンルタグの頻度一覧（チップ用）。 */
export function useGenres() {
  const client = useConnection((s) => s.client);
  return useQuery<GenreTagCount[]>({
    queryKey: browseKeys.genres,
    enabled: !!client,
    queryFn: () => client!.genres(),
  });
}

/** プレイリスト単体の情報（詳細ヘッダの名前など）。 */
export function usePlaylist(playlistId: number) {
  const client = useConnection((s) => s.client);
  return useQuery<PlaylistDetail>({
    queryKey: browseKeys.playlist(playlistId),
    enabled: !!client && Number.isFinite(playlistId),
    queryFn: () => client!.playlist(playlistId),
  });
}

/** アルバム一覧（distinct）。enabled=false で取得抑止。
 * 並びは「アルバムアーティスト → アルバム名 → 年(昇順)」。
 * /api/albums は year を返さないので、全曲キャッシュ（["tracks", {limit}]）が
 * 既にあれば代表年(MIN)を引いて年順まで効かせる。無ければ（＝重い全曲取得を
 * わざわざ誘発しないため取得はしない）「アーティスト → アルバム名」までで安定ソート。
 */
export function useAlbums(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  return useAlbumsUnsorted({
    enabled: options?.enabled,
    select: (albums) => {
      // 既にキャッシュ済みの全曲があれば年マップを引く（無ければ空＝年順はスキップ）。
      const tracks =
        queryClient.getQueryData<Track[]>(browseKeys.tracks({ limit: BROWSE_LIMIT })) ?? [];
      const years = albumYearMap(tracks);
      return [...albums].sort((a, b) =>
        compareAlbums(
          { album: a.album, albumArtist: a.albumArtist, year: years.get(a.album) ?? null },
          { album: b.album, albumArtist: b.albumArtist, year: years.get(b.album) ?? null },
        ),
      );
    },
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
  // 束ねキー（不明なアーティストは ""。/api/artists の artist と同じ）で突き合わせる。
  const nameOf = grouping === "albumArtist" ? trackAlbumArtistKey : trackArtistKey;
  const map = new Map<
    string,
    { album: string; albumArtist: string | null; trackCount: number; sampleTrackId: number; sampleDownloaded: boolean; year: number | null }
  >();
  for (const t of tracks) {
    if (nameOf(t) !== artist) continue;
    const album = (t.album ?? "").trim() ? (t.album as string) : "";
    // album が空/NULL の曲は "" キーで 1 グループ（「不明なアルバム」）に束ねる。
    // 表示は AlbumRow が空名を「不明なアルバム」と出し、遷移はアーティスト画面が
    // 専用パラメータ(noAlbum)へ振り分ける（/album/ 空セグメントのクラッシュは回避済み）。
    const isDownloaded = downloadedIds.has(t.trackId);
    const entry = map.get(album);
    if (entry) {
      entry.trackCount += 1;
      // 代表年は MIN(year)（再発盤などで年がばらつく場合に初出年へ寄せる）。
      if (t.year != null && (entry.year == null || t.year < entry.year)) {
        entry.year = t.year;
      }
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
        year: t.year,
      });
    }
  }
  // year は集計のみに使い、Album DTO（year を持たない）には載せず compareAlbums に渡す。
  return [...map.values()]
    .map(({ album, albumArtist, trackCount, sampleTrackId, year }) => ({ album, albumArtist, trackCount, sampleTrackId, year }))
    .sort((a, b) => {
      // 「不明なアルバム」(空アルバム) グループは常に末尾へ。
      if (!a.album !== !b.album) return a.album ? -1 : 1;
      return compareAlbums(a, b);
    })
    .map(({ album, albumArtist, trackCount, sampleTrackId }) => ({ album, albumArtist, trackCount, sampleTrackId }));
}

/** 指定アーティストのアルバム一覧（album でグルーピング）。
 * オンライン=サーバ側フィルタ済み曲（useArtistTracks と同じキャッシュ）からアルバム集計／
 * オフライン（client null）=DL 済み entries からフィルタ。
 * grouping を引数で上書き可能。省略時はストアの artistGrouping を使う。
 * ソートは albumArtist 順（同点は album 名）。
 */
export function useArtistAlbums(artist: string | null, grouping?: ArtistGrouping): Album[] {
  const client = useConnection((s) => s.client);
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  const entries = useDownloads((s) => s.entries);
  const downloadedIds = useMemo(() => new Set(Object.values(entries).map((e) => e.trackId)), [entries]);
  // オンライン時: ["artist-tracks", grouping, artist] キャッシュ（useArtistTracks と共有）からアルバムを集計。
  // サーバ側でアーティストフィルタ済みなので deriveArtistAlbums に artist を渡しても問題ない。
  const select = useCallback(
    (tracks: Track[]): Album[] =>
      artist == null ? [] : deriveArtistAlbums(tracks, artist, resolvedGrouping, downloadedIds),
    [artist, resolvedGrouping, downloadedIds],
  );
  const query = useQuery<Track[], Error, Album[]>({
    queryKey: browseKeys.artistTracks(resolvedGrouping, artist),
    enabled: !!client && artist != null,
    queryFn: ({ signal }) => client!.listTracks(artistTracksQuery(artist!, resolvedGrouping), signal),
    select,
    placeholderData: keepPreviousData,
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
    queryKey: browseKeys.similar(trackId),
    enabled: !!client && trackId != null,
    queryFn: () => client!.similar(trackId!),
  });
}

/**
 * 曲のレーティング設定ミューテーション。
 * - `rating` は 0..100 スケール（★ = rating/20）。ApiClient.setRating が clamp する。
 * - 書き込みは features/triage/edits.ts の writeRating（オンライン: 直接 setRating /
 *   オフライン: pendingEdits に enqueue。baseRating で再接続時の衝突検知）。
 * - 成功/失敗いずれでも rating を含む可能性のあるクエリ群を invalidate して再取得させる
 *   （楽観的な行の星表示は呼び出し側のローカル state で行う。ここはサーバ確定後の整合用）。
 */
export function useSetRating() {
  const qc = useQueryClient();

  return useMutation<void, Error, RatingEdit>({
    mutationFn: async (edit) => {
      await writeRating(edit);
    },
    // オフライン時は invalidate しても client 無しで再取得できないが害はない。
    onSettled: () => invalidateRatingQueries(qc),
  });
}
