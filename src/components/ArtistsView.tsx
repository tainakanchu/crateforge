import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useStore } from "../store/useStore";
import * as libraryApi from "../api/library";
import { Icon } from "./Icon";
import { ArtworkImg } from "./Cover";
import { artGradient, leadingGlyph } from "../lib/art";
import { ARTIST_SORT_FIELDS } from "../types";
import type { AlbumRow, ArtistRow, SortField, Track } from "../types";
import { EmptyState } from "./EmptyState";
import { albumLabel, artistLabel } from "../lib/unknownLabels";
import {
  GRID_GAP as GAP,
  GRID_META_H as META_H,
  GRID_PAD_X as PAD_X,
  gridLayout,
  gridMetrics,
  relocateExpanded,
} from "../lib/gridRows";
import type { GridExpanded } from "../lib/gridRows";
import { useElementWidth } from "../hooks/useElementWidth";
import { useCardGridVirtualizer } from "../hooks/useCardGridVirtualizer";
import { useWindowedList } from "../hooks/useWindowedList";
import { useListCount } from "../hooks/useListCount";
import { PlaceholderCard } from "./PlaceholderCard";
import { formatTotalTime, formatTrackTime } from "../lib/format";
import { isTauri } from "../lib/env";
import { combineQuery } from "../lib/query";
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import { CovTrackRow } from "./CovTrackRow";
import { useTrackActionRunner } from "../hooks/useTrackActionRunner";
import { LoadRetry } from "./LoadRetry";


/**
 * 表示中の一覧のアーティスト数 (検索中の見出しの件数用。Toolbar が読む)。未確定のあいだは null。
 */
export const useArtistsResult = create<{ count: number | null }>(() => ({ count: null }));

interface ArtistsViewProps {
  /// ライブラリ変更 (import / rip / 編集) のたびに増える値。変わったら取り直す。
  reloadKey: number;
}


const ARTIST_SORT_SET = new Set<string>(ARTIST_SORT_FIELDS);

/** 展開中のアーティスト。位置 (通し番号) と、展開行を描くためのアーティスト本体を覚える。 */
type ExpandedArtist = GridExpanded & { artist: ArtistRow };

/// アーティスト単位のブラウズビュー (viewMode = "artists")。
/// 集約はサーバ (`get_artists`) が行い、全曲をメモリに載せない。スクロール範囲は最初から
/// アーティスト全件ぶん確保し、見えている範囲だけを取得する (docs/library-list/design.md)。
/// 展開するとそのアーティストのアルバム (`get_artist_albums`)、さらに展開すると
/// アルバムの曲 (`get_album_tracks`) を遅延取得する。
export function ArtistsView({ reloadKey }: ArtistsViewProps) {
  const { playback, crate, addToCrate, sortField, sortOrder } = useStore();
  const pushToast = useStore((s) => s.pushToast);
  const run = useTrackActionRunner();
  // 検索ボックス + フィルタタグ (D4)。トラック一覧と同じ組み立て (App.tsx の combinedQuery)。
  const searchQuery = useStore((s) => s.searchQuery);
  const filterTags = useStore((s) => s.filterTags);
  const combinedQuery = useMemo(
    () => combineQuery(searchQuery, filterTags),
    [searchQuery, filterTags],
  );

  // グリッドのスクロール要素。初回描画は空状態 (データ到着前) で要素が無いので、
  // 付いた時点で幅計測を始められるよう callback ref で持つ (useElementWidth)。AlbumsView と同じ。
  const { ref: setParentRef, elRef: parentRef, width } = useElementWidth<HTMLDivElement>();
  // 展開中のアーティスト / その中で開いているアルバム (albumKey)。
  const [expanded, setExpanded] = useState<ExpandedArtist | null>(null);
  const [openAlbumKey, setOpenAlbumKey] = useState<string | null>(null);

  // 遅延取得キャッシュ。描画に使うが更新の粒度が細かいので ref + epoch で再描画する
  // (Map を state に持つと取得のたびに全体コピーが必要になるため)。
  const albumCache = useRef(new Map<string, AlbumRow[]>());
  const trackCache = useRef(new Map<string, Track[]>());
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const bumpCache = useCallback(() => setCacheEpoch((e) => e + 1), []);

  // ツールバーのソートはアーティスト粒度の語彙だけ通す (他は name に倒す)。
  // store 側でもビュー切替時に正規化しているので、ここは保険。
  const artistSort: SortField = ARTIST_SORT_SET.has(sortField) ? sortField : "name";
  const listKey = JSON.stringify(["artists", artistSort, sortOrder, combinedQuery]);

  const reportLoadError = useCallback(
    (err: unknown) => {
      console.error("Failed to load artists:", err);
      pushToast("error", `アーティストの取得に失敗しました: ${err}`);
    },
    [pushToast],
  );
  const count = useListCount(
    listKey,
    reloadKey,
    // ブラウザでの開発表示 (Tauri なし) は空の一覧として扱う。
    () => (isTauri ? libraryApi.countArtists(combinedQuery || undefined) : Promise.resolve(0)),
    reportLoadError,
  );
  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      libraryApi.getArtists(artistSort, sortOrder, limit, offset, combinedQuery || undefined),
    [artistSort, sortOrder, combinedQuery],
  );
  const list = useWindowedList<ArtistRow>({
    key: listKey,
    revision: reloadKey,
    count: count ?? 0,
    fetchPage,
    onError: reportLoadError,
  });
  const isLoading = count === null;

  // 見出しの件数 (検索結果のアーティスト数) を Toolbar へ渡す。
  useEffect(() => {
    useArtistsResult.setState({ count });
  }, [count]);
  useEffect(() => () => useArtistsResult.setState({ count: null }), []);

  // 一覧が切り替わったら (並び順・検索の変更) 先頭へ戻し、展開を閉じる。
  useEffect(() => {
    setExpanded(null);
    setOpenAlbumKey(null);
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }, [listKey, parentRef]);

  // 取得に失敗したキー (アーティスト名 / albumKey)。展開行が「Loading…」のまま止まらないよう、
  // 失敗を表示して再試行できるようにする。キャッシュと同じく ref + epoch で再描画する。
  const failedAlbums = useRef(new Set<string>());
  const failedTracks = useRef(new Set<string>());

  /// アーティストのアルバム一覧を取得してキャッシュする。失敗は throw する (通知は呼び出し側)。
  const fetchAlbums = useCallback(
    async (name: string): Promise<AlbumRow[]> => {
      const hit = albumCache.current.get(name);
      if (hit) return hit;
      if (failedAlbums.current.delete(name)) bumpCache(); // 再試行中は Loading… に戻す
      try {
        const rows = await libraryApi.getArtistAlbums(name);
        albumCache.current.set(name, rows);
        return rows;
      } catch (err) {
        failedAlbums.current.add(name);
        throw err;
      } finally {
        bumpCache();
      }
    },
    [bumpCache],
  );

  /// アルバムの曲を取得してキャッシュする。失敗は throw する (通知は呼び出し側)。
  const fetchTracks = useCallback(
    async (albumKey: string): Promise<Track[]> => {
      const hit = trackCache.current.get(albumKey);
      if (hit) return hit;
      if (failedTracks.current.delete(albumKey)) bumpCache();
      try {
        const ts = await libraryApi.getAlbumTracks(albumKey);
        trackCache.current.set(albumKey, ts);
        return ts;
      } catch (err) {
        failedTracks.current.add(albumKey);
        throw err;
      } finally {
        bumpCache();
      }
    },
    [bumpCache],
  );

  // 単発の取得: 失敗したらトーストで知らせて空を返す (再生・キュー・Crate が黙って何もしない、を避ける)。
  const ensureAlbums = useCallback(
    async (name: string): Promise<AlbumRow[]> => {
      let rows: AlbumRow[] = [];
      const ok = await run("loadAlbums", async () => {
        rows = await fetchAlbums(name);
      });
      return ok ? rows : [];
    },
    [fetchAlbums, run],
  );

  const ensureTracks = useCallback(
    async (albumKey: string): Promise<Track[]> => {
      let ts: Track[] = [];
      const ok = await run("loadTracks", async () => {
        ts = await fetchTracks(albumKey);
      });
      return ok ? ts : [];
    },
    [fetchTracks, run],
  );

  /// アーティストの全曲 (アルバム順 → disc/track 順)。未取得ぶんはここで取りに行く。
  /// アルバムごとの取得は並列なので、失敗の通知はアルバムの数だけ出さず 1 回にまとめる。
  /// 取得できたアルバムの曲はそのまま返す (操作は取れたぶんで続ける)。
  const artistTracks = useCallback(
    async (a: ArtistRow): Promise<Track[]> => {
      const albums = await ensureAlbums(a.name);
      const results = await Promise.allSettled(albums.map((al) => fetchTracks(al.albumKey)));
      const { items, failures } = trackActions.splitSettled(results);
      const message = trackActions.albumLoadFailureMessage(failures);
      if (message) {
        console.error("Failed to load album tracks:", failures);
        pushToast("error", message);
      }
      return items;
    },
    [ensureAlbums, fetchTracks, pushToast],
  );

  // 一覧の切り替え・ライブラリの変更で、展開用のキャッシュを捨てる。展開中のアーティスト
  // (と開いているアルバム) はすぐ取り直す。
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const openAlbumKeyRef = useRef(openAlbumKey);
  openAlbumKeyRef.current = openAlbumKey;
  const refetchOpenRef = useRef<() => void>(() => {});
  refetchOpenRef.current = () => {
    const open = expandedRef.current;
    if (!open) return;
    void ensureAlbums(open.key);
    if (openAlbumKeyRef.current) void ensureTracks(openAlbumKeyRef.current);
  };
  const cacheKeyRef = useRef(listKey);
  useEffect(() => {
    albumCache.current = new Map();
    trackCache.current = new Map();
    failedAlbums.current = new Set();
    failedTracks.current = new Set();
    bumpCache();
    // 一覧が切り替わったときは展開を閉じるので、取り直すものは無い。
    const sameList = cacheKeyRef.current === listKey;
    cacheKeyRef.current = listKey;
    if (sameList) refetchOpenRef.current();
  }, [listKey, reloadKey, bumpCache]);

  // 一覧を取り直したら、展開中のアーティストの位置を合わせ直す (無くなっていれば閉じる)。
  useEffect(() => {
    setExpanded((prev) => {
      if (!prev) return prev;
      const loadedKeys = (function* (): IterableIterator<[number, string]> {
        for (const [i, a] of list.loaded()) yield [i, a.name];
      })();
      const next = relocateExpanded(prev, list.count, (i) => list.get(i)?.name, loadedKeys);
      if (!next) return null;
      const artist = list.get(next.index) ?? prev.artist;
      return next === prev && artist === prev.artist ? prev : { ...next, artist };
    });
  }, [list]);

  const { cols, cardW } = gridMetrics(width);

  // カード行 (cols 枚ずつ) に、展開中アーティストの行を差し込んだ仮想行の並び。
  const layout = useMemo(() => gridLayout(list.count, cols, expanded), [list.count, cols, expanded]);

  // 行キーの安定化と再計測の規則は useCardGridVirtualizer 側。展開の開閉・アルバムの開閉・
  // 遅延取得の完了では measure() しない (実測キャッシュが消えて展開行が見積もり高さに戻り、
  // 次の行が重なる)。高さの変化は各行の ResizeObserver (measureElement) が拾う。
  const rowVirtualizer = useCardGridVirtualizer({
    layout,
    scrollRef: parentRef,
    gridRowHeight: cardW + META_H + GAP,
    onVisibleItems: list.setVisibleRange,
  });

  // index はカードの通し番号 (展開行を差し込む位置を決める)。
  const toggleArtist = useCallback(
    (a: ArtistRow, index: number) => {
      const willOpen = expanded?.key !== a.name;
      setExpanded(willOpen ? { key: a.name, index, artist: a } : null);
      setOpenAlbumKey(null);
      if (willOpen) void ensureAlbums(a.name);
    },
    [expanded, ensureAlbums],
  );

  const toggleAlbum = useCallback(
    (al: AlbumRow) => {
      const willOpen = openAlbumKey !== al.albumKey;
      setOpenAlbumKey(willOpen ? al.albumKey : null);
      if (willOpen) void ensureTracks(al.albumKey);
    },
    [openAlbumKey, ensureTracks],
  );

  // ---- 再生 / キュー / クレート ----

  const playTracks = useCallback(async (ts: Track[], startId?: number) => {
    await run("play", () => trackActions.playTracks(trackApi, ts, startId));
  }, [run]);

  const enqueueTracks = useCallback(
    async (ts: Track[]) => {
      const ids = trackActions.playableIds(ts);
      if (ids.length === 0) return;
      await run("enqueue", async () => {
        await trackActions.enqueueTracks(trackApi, ids);
        pushToast("success", `${ids.length} 曲をキューに追加しました`);
      });
    },
    [pushToast, run],
  );

  const crateTracks = useCallback(
    (ts: Track[]) => {
      for (const t of ts) addToCrate(t);
    },
    [addToCrate],
  );

  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  /// キャッシュ済みの曲だけ (未取得なら null)。カードの「クレート済み」「再生中」表示に使う。
  const knownArtistTracks = useCallback(
    (a: ArtistRow): Track[] | null => {
      const albums = albumCache.current.get(a.name);
      if (!albums) return null;
      const out: Track[] = [];
      for (const al of albums) {
        const ts = trackCache.current.get(al.albumKey);
        if (!ts) return null;
        out.push(...ts);
      }
      return out;
    },
    // cacheEpoch が変わったら引き直す (ref なので依存に入れて明示する)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cacheEpoch],
  );

  if (list.count === 0 && !isLoading) {
    return (
      <div className="cb-grid-wrap">
        <EmptyState />
      </div>
    );
  }

  const items = rowVirtualizer.getVirtualItems();

  return (
    <div className="cb-grid-wrap" ref={setParentRef}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
        {items.map((vRow) => {
          const row = layout.rowAt(vRow.index);
          return (
            <div
              key={vRow.key}
              data-index={vRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              {row.type === "grid" ? (
                <div
                  style={{
                    display: "grid",
                    // minmax(0,1fr): 折り返さない CJK 名でも列が膨らまないように。
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    gap: GAP,
                    padding: `0 ${PAD_X}px ${GAP}px`,
                  }}
                >
                  {Array.from({ length: row.end - row.start }, (_, j) => {
                    const index = row.start + j;
                    const a = list.get(index);
                    // 未取得のアーティストは同じ高さのプレースホルダ (届いても行がずれない)。
                    if (!a) return <PlaceholderCard key={`ph:${index}`} size={cardW} />;
                    const kt = knownArtistTracks(a);
                    const allIn = kt ? kt.length > 0 && kt.every((t) => crateSet.has(t.trackId)) : false;
                    const isCurrent = kt
                      ? kt.some((t) => playback.currentTrackId === t.trackId)
                      : false;
                    const isOpen = expanded?.key === a.name;
                    return (
                      <div key={a.name} className="cb-cardwrap">
                        <div
                          className={
                            "cb-card" +
                            (allIn ? " incrate" : "") +
                            (isCurrent ? " playing" : "") +
                            (isOpen ? " opened" : "")
                          }
                          style={{ background: artGradient(artistLabel(a.name)), height: cardW }}
                          onClick={() => toggleArtist(a, index)}
                          onDoubleClick={() => artistTracks(a).then((ts) => playTracks(ts))}
                        >
                          <span className="glyph">{leadingGlyph(artistLabel(a.name))}</span>
                          <ArtworkImg path={a.artworkLocationPath} size={cardW} />
                          <span className="grad" />
                          <div className="kbtag">
                            {a.albumCount > 1 && (
                              <span title={`${a.albumCount} albums`}>{a.albumCount}</span>
                            )}
                          </div>
                          <button
                            className="cov-play"
                            title="このアーティストを再生"
                            onClick={(e) => {
                              e.stopPropagation();
                              artistTracks(a).then((ts) => playTracks(ts));
                            }}
                          >
                            <Icon name="play" size={20} fill="currentColor" stroke={0} />
                          </button>
                          {allIn ? (
                            <span
                              className="addbtn"
                              style={{ opacity: 1, transform: "none" }}
                              title="すべて Crate に追加済み"
                            >
                              <Icon name="check" size={17} />
                            </span>
                          ) : (
                            <button
                              className="addbtn"
                              title="このアーティストを Crate に追加"
                              onClick={(e) => {
                                e.stopPropagation();
                                artistTracks(a).then(crateTracks);
                              }}
                            >
                              <Icon name="plus" size={17} />
                            </button>
                          )}
                          <span className="cov-chev" data-open={isOpen ? "1" : "0"}>
                            <Icon name="chevronD" size={15} />
                          </span>
                        </div>
                        <div
                          className="cov-meta"
                          onClick={() => toggleArtist(a, index)}
                          title={`${artistLabel(a.name)} — ${a.albumCount} アルバム · ${a.trackCount} 曲`}
                        >
                          <div className="cj">{artistLabel(a.name)}</div>
                          <div className="la">
                            {a.trackCount} 曲 · {a.albumCount} アルバム
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                expanded && (
                  <ArtistExpansion
                    artist={expanded.artist}
                    albums={albumCache.current.get(expanded.key) ?? null}
                    openAlbumKey={openAlbumKey}
                    tracksOf={(key) => trackCache.current.get(key) ?? null}
                    albumsFailed={failedAlbums.current.has(expanded.key)}
                    tracksFailed={(key) => failedTracks.current.has(key)}
                    onRetryAlbums={() => void ensureAlbums(expanded.key)}
                    onRetryTracks={(al) => void ensureTracks(al.albumKey)}
                    crateSet={crateSet}
                    currentTrackId={playback.currentTrackId}
                    onToggleAlbum={toggleAlbum}
                    onPlayArtist={() => artistTracks(expanded.artist).then((ts) => playTracks(ts))}
                    onQueueArtist={() => artistTracks(expanded.artist).then(enqueueTracks)}
                    onCrateArtist={() => artistTracks(expanded.artist).then(crateTracks)}
                    onPlayAlbum={(al, startId) =>
                      ensureTracks(al.albumKey).then((ts) => playTracks(ts, startId))
                    }
                    onQueueAlbum={(al) => ensureTracks(al.albumKey).then(enqueueTracks)}
                    onCrateAlbum={(al) => ensureTracks(al.albumKey).then(crateTracks)}
                    onCrateTrack={addToCrate}
                    onClose={() => {
                        setExpanded(null);
                        setOpenAlbumKey(null);
                      }}
                  />
                )
              )}
            </div>
          );
        })}
      </div>
      {isLoading && <div className="cb-loading">Loading…</div>}
    </div>
  );
}

interface ArtistExpansionProps {
  artist: ArtistRow;
  /// null = アルバム一覧を取得中。
  albums: AlbumRow[] | null;
  openAlbumKey: string | null;
  tracksOf: (albumKey: string) => Track[] | null;
  /// アルバム一覧 / アルバムの曲の取得に失敗している (再試行の表示に切り替える)。
  albumsFailed: boolean;
  tracksFailed: (albumKey: string) => boolean;
  onRetryAlbums: () => void;
  onRetryTracks: (album: AlbumRow) => void;
  crateSet: Set<number>;
  currentTrackId: number | null;
  onToggleAlbum: (album: AlbumRow) => void;
  onPlayArtist: () => void;
  onQueueArtist: () => void;
  onCrateArtist: () => void;
  onPlayAlbum: (album: AlbumRow, startTrackId?: number) => void;
  onQueueAlbum: (album: AlbumRow) => void;
  onCrateAlbum: (album: AlbumRow) => void;
  onCrateTrack: (track: Track) => void;
  onClose: () => void;
}

/// 展開行: アーティストのアルバム一覧。アルバムを開くとその曲一覧を出す。
function ArtistExpansion({
  artist,
  albums,
  openAlbumKey,
  tracksOf,
  albumsFailed,
  tracksFailed,
  onRetryAlbums,
  onRetryTracks,
  crateSet,
  currentTrackId,
  onToggleAlbum,
  onPlayArtist,
  onQueueArtist,
  onCrateArtist,
  onPlayAlbum,
  onQueueAlbum,
  onCrateAlbum,
  onCrateTrack,
  onClose,
}: ArtistExpansionProps) {
  return (
    // ラッパの padding で行間を確保する (margin だと計測高さに含まれず仮想行が重なる)。
    <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
      <div className="cov-exp">
        <div className="cov-exp-head">
          <div className="cov-exp-title">
            <span className="t">{artistLabel(artist.name)}</span>
            <span className="s">
              {artist.albumCount} アルバム · {artist.trackCount} 曲
            </span>
          </div>
          <div className="art-exp-actions">
            <button className="cb-btn" title="すべて再生" onClick={onPlayArtist}>
              <Icon name="play" size={13} fill="currentColor" stroke={0} /> 再生
            </button>
            <button className="cb-btn" title="すべてキューに追加" onClick={onQueueArtist}>
              <Icon name="list" size={13} /> キュー
            </button>
            <button className="cb-btn" title="すべて Crate に追加" onClick={onCrateArtist}>
              <Icon name="plus" size={13} /> Crate
            </button>
            <button className="cov-exp-close" title="Collapse" onClick={onClose}>
              <Icon name="chevronD" size={16} style={{ transform: "rotate(180deg)" }} />
            </button>
          </div>
        </div>
        {albums === null ? (
          albumsFailed ? (
            <LoadRetry message="アルバムを取得できませんでした" onRetry={onRetryAlbums} />
          ) : (
            <div className="cb-loading">Loading…</div>
          )
        ) : (
          <div className="art-albs">
            {albums.map((al) => {
              const isOpen = openAlbumKey === al.albumKey;
              const tracks = isOpen ? tracksOf(al.albumKey) : null;
              return (
                <div key={al.albumKey} className={"art-alb" + (isOpen ? " open" : "")}>
                  <div className="art-alb-head" onClick={() => onToggleAlbum(al)}>
                    <div
                      className="art-alb-cover"
                      style={{ background: artGradient(albumLabel(al.album)) }}
                    >
                      <span className="glyph">{leadingGlyph(albumLabel(al.album))}</span>
                      <ArtworkImg path={al.coverFileExists ? al.coverLocationPath : null} size={38} />
                    </div>
                    <div className="art-alb-meta">
                      <div className="t">{albumLabel(al.album)}</div>
                      <div className="s">
                        {al.year != null ? `${al.year} · ` : ""}
                        {al.trackCount} 曲
                        {al.totalTimeMs > 0 ? ` · ${formatTotalTime(al.totalTimeMs)}` : ""}
                      </div>
                    </div>
                    <button
                      className="art-alb-btn"
                      title="アルバムを再生"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayAlbum(al);
                      }}
                    >
                      <Icon name="play" size={14} fill="currentColor" stroke={0} />
                    </button>
                    <button
                      className="art-alb-btn"
                      title="アルバムをキューに追加"
                      onClick={(e) => {
                        e.stopPropagation();
                        onQueueAlbum(al);
                      }}
                    >
                      <Icon name="list" size={14} />
                    </button>
                    <button
                      className="art-alb-btn"
                      title="アルバムを Crate に追加"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCrateAlbum(al);
                      }}
                    >
                      <Icon name="plus" size={14} />
                    </button>
                    <span className="cov-chev" data-open={isOpen ? "1" : "0"}>
                      <Icon name="chevronD" size={14} />
                    </span>
                  </div>
                  {isOpen &&
                    (tracks === null ? (
                      tracksFailed(al.albumKey) ? (
                        <LoadRetry
                          message="曲を取得できませんでした"
                          onRetry={() => onRetryTracks(al)}
                        />
                      ) : (
                        <div className="cb-loading">Loading…</div>
                      )
                    ) : (
                      <div className="cov-trks">
                        {tracks.map((t, i) => {
                          const isIn = crateSet.has(t.trackId);
                          const isCurrent = currentTrackId === t.trackId;
                          const showArtist = !!t.artist && t.artist !== artist.name;
                          return (
                            // 列は番号 / 曲名 / 長さ / +Crate のみ (ui-spec 3.2)。extra は渡さない。
                            <CovTrackRow
                              key={`${t.trackId}-${i}`}
                              track={t}
                              index={i}
                              isCurrent={isCurrent}
                              inCrate={isIn}
                              showArtist={showArtist}
                              time={formatTrackTime(t.totalTimeMs)}
                              onPlay={() => onPlayAlbum(al, t.trackId)}
                              onAddToCrate={() => onCrateTrack(t)}
                            />
                          );
                        })}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
