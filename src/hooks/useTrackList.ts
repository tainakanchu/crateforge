import { useCallback, useMemo, useRef } from "react";
import { useStore } from "../store/useStore";
import * as libraryApi from "../api/library";
import { fetchTrackIds, fetchTrackPage, isServerTrackList } from "../api/trackList";
import { resolveTrackListQuery, trackListKey } from "../lib/trackListQuery";
import type { TrackListQuery } from "../lib/trackListQuery";
import { useWindowedList } from "./useWindowedList";
import type { WindowedList } from "./useWindowedList";
import type { Track } from "../types";

/** 表示中の曲の一覧 (どの一覧か) とそのキー。ストアの状態から決まる。 */
export function useTrackListQuery(): { query: TrackListQuery; key: string } {
  const viewMode = useStore((s) => s.viewMode);
  const selectedPlaylistId = useStore((s) => s.selectedPlaylistId);
  const playlistIsSmart = useStore(
    (s) => s.playlists.find((p) => p.playlistId === s.selectedPlaylistId)?.isSmart ?? false,
  );
  const searchQuery = useStore((s) => s.searchQuery);
  const searchScope = useStore((s) => s.searchScope);
  const filterTags = useStore((s) => s.filterTags);
  const sortField = useStore((s) => s.sortField);
  const sortOrder = useStore((s) => s.sortOrder);
  return useMemo(() => {
    const query = resolveTrackListQuery({
      viewMode,
      selectedPlaylistId,
      playlistIsSmart,
      searchQuery,
      searchScope,
      filterTags,
      sortField,
      sortOrder,
    });
    return { query, key: trackListKey(query) };
  }, [
    viewMode,
    selectedPlaylistId,
    playlistIsSmart,
    searchQuery,
    searchScope,
    filterTags,
    sortField,
    sortOrder,
  ]);
}

export interface TrackList extends WindowedList<Track> {
  query: TrackListQuery;
  /** 一覧の同一性。変わったら先頭へ戻す。 */
  key: string;
  /** 件数がまだ確定していない (一覧を開いた直後)。 */
  loading: boolean;
  /** 一覧の全 trackId (表示順)。初回に取得し、一覧が取り直されるまで使い回す。 */
  getIds: () => Promise<number[]>;
  /** 取得済みなら全 trackId (表示順)。未取得なら null (同期で要るドラッグ開始用)。 */
  peekIds: () => readonly number[] | null;
  /** 取得済みの行から trackId の曲を引く (同じ曲が複数行あれば最初の行)。 */
  loadedTrack: (trackId: number) => Track | undefined;
  /** 取得済みの行から trackId の行番号を引く (同じ曲が複数行あれば最初の行)。 */
  loadedIndexOf: (trackId: number) => number | undefined;
  /** trackId 列を曲に解決する (入力順。取得済みの行に無いぶんは ID で取り直す)。 */
  resolveTracks: (ids: readonly number[]) => Promise<Track[]>;
  /** trackId 列を一覧の表示順に並べ直す (重複は除く。一覧に無い ID は末尾)。 */
  orderByList: (ids: readonly number[]) => Promise<number[]>;
}

/**
 * 表示中の曲の一覧 (TrackTable / TracksView 用)。docs/library-list/design.md。
 *
 * - ライブラリ / 検索 / プレイリストは、件数ぶんの行を確保して見えているページだけ取得する。
 * - Inbox / 最近再生した曲はストアの `tracks` (件数に上限のあるメモリ上の一覧) を同じ形で見せる。
 *
 * 件数は App が取ってストアの `listCount` に置く (ツールバーの件数表示と共有する)。
 * 読み込んでいない行をまたぐ操作 (全選択・範囲選択・ここから再生) は `getIds` の ID 列を使う。
 */
export function useTrackList(): TrackList {
  const { query, key } = useTrackListQuery();
  const memoryTracks = useStore((s) => s.tracks);
  const memoryLoading = useStore((s) => s.isLoading);
  const listCount = useStore((s) => s.listCount);
  const libraryRevision = useStore((s) => s.libraryRevision);
  const pushToast = useStore((s) => s.pushToast);

  const server = isServerTrackList(query) ? query : null;
  const count = server
    ? listCount !== null && listCount.key === key
      ? listCount.count
      : null
    : query.kind === "memory"
      ? memoryTracks.length
      : 0;
  const revision: unknown = server ? libraryRevision : memoryTracks;

  const fetchPage = useCallback(
    async (offset: number, limit: number): Promise<Track[]> =>
      server ? fetchTrackPage(server, offset, limit) : memoryTracks.slice(offset, offset + limit),
    [server, memoryTracks],
  );
  const onError = useCallback(
    (err: unknown) => {
      console.error("Failed to load tracks:", err);
      pushToast("error", `曲の取得に失敗しました: ${err}`);
    },
    [pushToast],
  );
  const list = useWindowedList<Track>({ key, revision, count: count ?? 0, fetchPage, onError });

  // 全 trackId は一覧 (key + revision) ごとに 1 回だけ取る。
  const idsRef = useRef<{
    key: string;
    revision: unknown;
    promise: Promise<number[]>;
    ids: number[] | null;
  } | null>(null);
  const current = useRef({ key, revision, server, memoryTracks });
  current.current = { key, revision, server, memoryTracks };

  const getIds = useCallback((): Promise<number[]> => {
    const now = current.current;
    const cached = idsRef.current;
    if (cached && cached.key === now.key && Object.is(cached.revision, now.revision)) {
      return cached.promise;
    }
    const promise = now.server
      ? fetchTrackIds(now.server)
      : Promise.resolve(now.memoryTracks.map((t) => t.trackId));
    const entry = { key: now.key, revision: now.revision, promise, ids: null as number[] | null };
    idsRef.current = entry;
    promise.then(
      (ids) => {
        entry.ids = ids;
      },
      () => {
        // 失敗した取得は使い回さない (次の操作で取り直す)。
        if (idsRef.current === entry) idsRef.current = null;
      },
    );
    return promise;
  }, []);

  const peekIds = useCallback((): readonly number[] | null => {
    const now = current.current;
    const cached = idsRef.current;
    return cached && cached.key === now.key && Object.is(cached.revision, now.revision)
      ? cached.ids
      : null;
  }, []);

  // 取得済みの行の索引 (trackId → 最初の行)。ページが届くたびに作り直す (最大でキャッシュぶん)。
  const loadedById = useMemo(() => {
    const map = new Map<number, { index: number; track: Track }>();
    for (const [index, track] of list.loaded()) {
      if (!map.has(track.trackId)) map.set(track.trackId, { index, track });
    }
    return map;
    // key: 一覧が切り替わって件数が同じまま (ページ未着) でも作り直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, key]);

  const loadedTrack = useCallback((id: number) => loadedById.get(id)?.track, [loadedById]);
  const loadedIndexOf = useCallback((id: number) => loadedById.get(id)?.index, [loadedById]);

  const resolveTracks = useCallback(
    async (ids: readonly number[]): Promise<Track[]> => {
      const found = new Map<number, Track>();
      const missing: number[] = [];
      for (const id of ids) {
        const t = loadedById.get(id)?.track;
        if (t) found.set(id, t);
        else missing.push(id);
      }
      if (missing.length > 0) {
        for (const t of await libraryApi.getTracksByIds(missing)) found.set(t.trackId, t);
      }
      return ids.map((id) => found.get(id)).filter((t): t is Track => t !== undefined);
    },
    [loadedById],
  );

  const orderByList = useCallback(
    async (ids: readonly number[]): Promise<number[]> => {
      if (ids.length <= 1) return [...ids];
      const wanted = new Set(ids);
      const out: number[] = [];
      for (const id of await getIds()) {
        if (wanted.delete(id)) out.push(id);
      }
      return [...out, ...wanted];
    },
    [getIds],
  );

  return useMemo(
    () => ({
      ...list,
      query,
      key,
      loading: count === null || (query.kind === "memory" && memoryLoading),
      getIds,
      peekIds,
      loadedTrack,
      loadedIndexOf,
      resolveTracks,
      orderByList,
    }),
    [list, query, key, count, memoryLoading, getIds, peekIds, loadedTrack, loadedIndexOf, resolveTracks, orderByList],
  );
}
