// Browse スライスの React Query フック群。
// 全フックは useConnection().client（接続中のみ非 null）を読み、enabled: !!client。
// queryFn では client のメソッドを使い、AbortSignal を受け取る経路には渡す。
// ApiClient.artists() / TracksQuery.artist / TracksQuery.albumArtist の型拡張は
// lib/api/augment.d.ts に宣言している（別エージェントが core に実装する新 IF）。

import { useCallback, useMemo } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type Album, type Artist, type ArtistGrouping, type GenreTagCount, type Playlist, type PlaylistDetail, type SimilarHit, type Track, type TracksQuery, trackArtist, trackAlbumArtist, useConnection, useDownloads, useSettings } from "@crateforge/core";

/** 大規模ライブラリでも全件取得（仮想リスト前提）。500/200 上限の撤廃。 */
export const BROWSE_LIMIT = 100000;

/** アルバム並べ替えに必要な最小キー。year は代表年（MIN 推奨, 無ければ null）。 */
type AlbumSortKey = { album: string; albumArtist: string | null; year?: number | null };

/**
 * アルバムの共通ソート比較。順序は「アルバムアーティスト → アルバム名 → 年(昇順)」。
 * - 名前比較は localeCompare（base sensitivity）。読み仮名フィールドが無いため漢字は
 *   文字コード順になり得るが許容（簡易ソート）。ロケールは undefined（Hermes 互換重視）。
 * - year は MIN(year) を想定。null/undefined は「年不明」として最後に置く。
 * deriveArtistAlbums と useAlbums の両方から再利用して重複を避ける。
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

/** 曲一覧（検索/ジャンル等のクエリで絞り込み）。enabled=false で取得抑止（非表示モード時）。
 * placeholderData: keepPreviousData で検索/ソート/モード変更時のスピナー点滅を抑える。
 */
export function useTracks(query?: TracksQuery, enabled = true) {
  const client = useConnection((s) => s.client);
  return useQuery<Track[]>({
    queryKey: ["tracks", query ?? {}],
    enabled: !!client && enabled,
    queryFn: ({ signal }) => client!.listTracks(query, signal),
    placeholderData: keepPreviousData,
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

/** アルバム一覧（distinct）。enabled=false で取得抑止。
 * 並びは「アルバムアーティスト → アルバム名 → 年(昇順)」。
 * /api/albums は year を返さないので、全曲キャッシュ（["tracks", {limit}]）が
 * 既にあれば代表年(MIN)を引いて年順まで効かせる。無ければ（＝重い全曲取得を
 * わざわざ誘発しないため取得はしない）「アーティスト → アルバム名」までで安定ソート。
 * placeholderData: keepPreviousData で grouping/検索変更時のスピナー点滅を抑える。
 */
export function useAlbums(enabled = true) {
  const client = useConnection((s) => s.client);
  const queryClient = useQueryClient();
  return useQuery<Album[], Error, Album[]>({
    queryKey: ["albums"],
    enabled: !!client && enabled,
    queryFn: () => client!.albums(),
    placeholderData: keepPreviousData,
    select: (albums) => {
      // 既にキャッシュ済みの全曲があれば年マップを引く（無ければ空＝年順はスキップ）。
      const tracks =
        queryClient.getQueryData<Track[]>(["tracks", { limit: BROWSE_LIMIT }]) ?? [];
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

/** アーティスト一覧（サーバ側 /api/artists で集計）。enabled=false で取得抑止。
 * grouping を引数で上書き可能。省略時はストアの artistGrouping を読む。
 * 従来はクライアント側で全曲から集計していたが、サーバ側の専用エンドポイントに切替えて
 * 重い全曲転送を回避する。キーを ["artists", grouping] にして永続化の対象にも含める。
 * placeholderData: keepPreviousData で grouping 切替時のスピナー点滅を抑える。
 */
export function useArtists(enabled = true, grouping?: ArtistGrouping) {
  const client = useConnection((s) => s.client);
  // 引数省略時はストアの設定を使う（index.tsx が引数なしで呼ぶため）。
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  return useQuery<Artist[]>({
    queryKey: ["artists", resolvedGrouping],
    enabled: !!client && enabled,
    queryFn: () => client!.artists(resolvedGrouping),
    placeholderData: keepPreviousData,
  });
}

/** 指定アーティストの曲（artist が null のときは無効）。
 * grouping を引数で上書き可能。省略時はストアの artistGrouping を使う。
 * サーバ側 artist/albumArtist フィルタで取得するため全曲転送を回避する。
 * placeholderData: keepPreviousData でアーティスト切替時のスピナー点滅を抑える。
 */
export function useArtistTracks(artist: string | null, grouping?: ArtistGrouping) {
  const client = useConnection((s) => s.client);
  // 引数省略時はストアから読む。
  const storedGrouping = useSettings((s) => s.artistGrouping);
  const resolvedGrouping = grouping ?? storedGrouping;
  return useQuery<Track[]>({
    queryKey: ["artist-tracks", resolvedGrouping, artist],
    enabled: !!client && artist != null,
    queryFn: ({ signal }) =>
      resolvedGrouping === "albumArtist"
        ? client!.listTracks({ albumArtist: artist!, limit: BROWSE_LIMIT }, signal)
        : client!.listTracks({ artist: artist!, limit: BROWSE_LIMIT }, signal),
    placeholderData: keepPreviousData,
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
    { album: string; albumArtist: string | null; trackCount: number; sampleTrackId: number; sampleDownloaded: boolean; year: number | null }
  >();
  for (const t of tracks) {
    if (nameOf(t) !== artist) continue;
    const album = t.album ?? "";
    // album が空/NULL の曲は "" キーで 1 グループ（「アルバムなし」）に束ねる。
    // 表示は AlbumRow が空名を「アルバムなし」と出し、遷移はアーティスト画面が
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
      // 「アルバムなし」(空アルバム) グループは常に末尾へ。
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
    queryKey: ["artist-tracks", resolvedGrouping, artist],
    enabled: !!client && artist != null,
    queryFn: ({ signal }) =>
      resolvedGrouping === "albumArtist"
        ? client!.listTracks({ albumArtist: artist!, limit: BROWSE_LIMIT }, signal)
        : client!.listTracks({ artist: artist!, limit: BROWSE_LIMIT }, signal),
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
    queryKey: ["similar", trackId],
    enabled: !!client && trackId != null,
    queryFn: () => client!.similar(trackId!),
  });
}

/** rating を含むキャッシュ済みクエリのキープレフィックス（無効化対象）。 */
const RATING_AFFECTED_KEYS = [
  ["tracks"],
  ["artist-tracks"],
  ["album-tracks"],
  ["playlist-tracks"],
  ["similar"],
] as const;

/**
 * 曲のレーティング設定ミューテーション。
 * - `rating` は 0..100 スケール（★ = rating/20）。ApiClient.setRating が clamp する。
 * - 成功/失敗いずれでも rating を含む可能性のあるクエリ群を invalidate して再取得させる
 *   （楽観的な行の星表示は呼び出し側のローカル state で行う。ここはサーバ確定後の整合用）。
 * - client 未接続（オフライン）時は何もしない no-op を返す。
 */
export function useSetRating() {
  const client = useConnection((s) => s.client);
  const qc = useQueryClient();

  const mutation = useMutation<void, Error, { trackId: number; rating: number }>({
    mutationFn: async ({ trackId, rating }) => {
      if (!client) return;
      await client.setRating(trackId, rating);
    },
    onSettled: async () => {
      await Promise.all(
        RATING_AFFECTED_KEYS.map((key) => qc.invalidateQueries({ queryKey: key })),
      );
    },
  });

  return mutation;
}
