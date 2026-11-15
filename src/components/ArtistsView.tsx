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
  buildGridRows,
  gridMetrics,
  isNearBottom,
} from "../lib/gridRows";
import { useElementWidth } from "../hooks/useElementWidth";
import { useCardGridVirtualizer } from "../hooks/useCardGridVirtualizer";
import { formatClock } from "../lib/format";
import { isTauri } from "../lib/env";
import { combineQuery } from "../lib/query";
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import { CovTrackRow } from "./CovTrackRow";


/**
 * 表示中のアーティスト数 (検索中の見出しの件数用。Toolbar が読む)。
 * 追加ページがあるときは取得済みの数 + "以上" を示すため hasMore も持つ。
 */
export const useArtistsResult = create<{ count: number | null; hasMore: boolean }>(() => ({
  count: null,
  hasMore: false,
}));

/// サーバ集約を 1 ページずつ取る件数 (App.tsx のトラック取得と同じ粒度)。
const PAGE_SIZE = 500;

interface ArtistsViewProps {
  /// ライブラリ変更 (import / rip / 編集) のたびに増える値。変わったら取り直す。
  reloadKey: number;
}

// 現行の表示を保つ (1 時間以上は h:mm:ss・切り捨て・値なしは空)。統一はフェーズ 2 (A2)。
const formatTime = (ms: number | null) => formatClock(ms, { hours: true, empty: "" });

const ARTIST_SORT_SET = new Set<string>(ARTIST_SORT_FIELDS);

const artistKeyOf = (a: ArtistRow) => a.name;

/// アーティスト単位のブラウズビュー (viewMode = "artists")。
/// 集約はサーバ (`get_artists`) が行い、全曲をメモリに載せない。カードは仮想化し、
/// 展開するとそのアーティストのアルバム (`get_artist_albums`)、さらに展開すると
/// アルバムの曲 (`get_album_tracks`) を遅延取得する。
export function ArtistsView({ reloadKey }: ArtistsViewProps) {
  const { playback, crate, addToCrate, sortField, sortOrder } = useStore();
  const pushToast = useStore((s) => s.pushToast);
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
  const [artists, setArtists] = useState<ArtistRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // 展開中のアーティスト名 / その中で開いているアルバム (albumKey)。
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openAlbumKey, setOpenAlbumKey] = useState<string | null>(null);

  // 遅延取得キャッシュ。描画に使うが更新の粒度が細かいので ref + epoch で再描画する
  // (Map を state に持つと取得のたびに全体コピーが必要になるため)。
  const albumCache = useRef(new Map<string, AlbumRow[]>());
  const trackCache = useRef(new Map<string, Track[]>());
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const bumpCache = useCallback(() => setCacheEpoch((e) => e + 1), []);

  // 追加ロードの offset 計算で使う (state の閉じ込みを避ける)。
  const artistsRef = useRef<ArtistRow[]>([]);
  useEffect(() => {
    artistsRef.current = artists;
  }, [artists]);
  // 見出しの件数 (検索結果のアーティスト数) を Toolbar へ渡す。
  useEffect(() => {
    useArtistsResult.setState({ count: isLoading ? null : artists.length, hasMore });
  }, [artists.length, hasMore, isLoading]);
  useEffect(() => () => useArtistsResult.setState({ count: null, hasMore: false }), []);
  const loadingRef = useRef(false);
  // 取得のたびに増やす連番。応答が返ったとき最新でなければ (ソート変更などで
  // 後発のリクエストが走っていれば) その結果は捨てる。
  const reqSeq = useRef(0);

  // ツールバーのソートはアーティスト粒度の語彙だけ通す (他は name に倒す)。
  // store 側でもビュー切替時に正規化しているので、ここは保険。
  const artistSort: SortField = ARTIST_SORT_SET.has(sortField) ? sortField : "name";

  const load = useCallback(
    async (reset: boolean) => {
      if (!isTauri) {
        setArtists([]);
        setHasMore(false);
        return;
      }
      // 追加ロードの二重発火だけ抑止する (取り直しは常に走らせる)。
      if (!reset && loadingRef.current) return;
      const seq = ++reqSeq.current;
      loadingRef.current = true;
      setIsLoading(true);
      try {
        const offset = reset ? 0 : artistsRef.current.length;
        const rows = await libraryApi.getArtists(
          artistSort,
          sortOrder,
          PAGE_SIZE,
          offset,
          combinedQuery || undefined,
        );
        if (seq !== reqSeq.current) return; // 古い応答は捨てる
        setArtists((prev) => (reset ? rows : [...prev, ...rows]));
        setHasMore(rows.length === PAGE_SIZE);
      } catch (err) {
        if (seq !== reqSeq.current) return;
        console.error("Failed to load artists:", err);
        pushToast("error", `アーティストの取得に失敗しました: ${err}`);
      } finally {
        // 後発リクエストが走っているなら、そちらの完了に任せる。
        if (seq === reqSeq.current) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [artistSort, sortOrder, combinedQuery, pushToast],
  );

  // ソート変更・検索変更・ライブラリ変更で先頭から取り直す (キャッシュも捨てる)。
  useEffect(() => {
    setExpanded(null);
    setOpenAlbumKey(null);
    setHasMore(false);
    albumCache.current = new Map();
    trackCache.current = new Map();
    bumpCache();
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistSort, sortOrder, combinedQuery, reloadKey]);

  const ensureAlbums = useCallback(
    async (name: string): Promise<AlbumRow[]> => {
      const hit = albumCache.current.get(name);
      if (hit) return hit;
      try {
        const rows = await libraryApi.getArtistAlbums(name);
        albumCache.current.set(name, rows);
        bumpCache();
        return rows;
      } catch (err) {
        console.error("Failed to load artist albums:", err);
        return [];
      }
    },
    [bumpCache],
  );

  const ensureTracks = useCallback(
    async (albumKey: string): Promise<Track[]> => {
      const hit = trackCache.current.get(albumKey);
      if (hit) return hit;
      try {
        const ts = await libraryApi.getAlbumTracks(albumKey);
        trackCache.current.set(albumKey, ts);
        bumpCache();
        return ts;
      } catch (err) {
        console.error("Failed to load album tracks:", err);
        return [];
      }
    },
    [bumpCache],
  );

  /// アーティストの全曲 (アルバム順 → disc/track 順)。未取得ぶんはここで取りに行く。
  const artistTracks = useCallback(
    async (a: ArtistRow): Promise<Track[]> => {
      const albums = await ensureAlbums(a.name);
      const lists = await Promise.all(albums.map((al) => ensureTracks(al.albumKey)));
      return lists.flat();
    },
    [ensureAlbums, ensureTracks],
  );

  const { cols, cardW } = gridMetrics(width);

  // グリッド行 (cols 枚ずつ) に、展開中アーティストの行を差し込んだ仮想行リスト。
  const rows = useMemo(
    () => buildGridRows(artists, cols, artistKeyOf, expanded),
    [artists, cols, expanded],
  );

  // 行キーの安定化と再計測の規則は useCardGridVirtualizer 側。展開の開閉・アルバムの開閉・
  // 遅延取得の完了では measure() しない (実測キャッシュが消えて展開行が見積もり高さに戻り、
  // 次の行が重なる)。高さの変化は各行の ResizeObserver (measureElement) が拾う。
  const rowVirtualizer = useCardGridVirtualizer({
    rows,
    scrollRef: parentRef,
    cols,
    gridRowHeight: cardW + META_H + GAP,
  });

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !hasMore) return;
    if (isNearBottom(el)) void load(false);
  }, [isLoading, hasMore, load]);

  const toggleArtist = useCallback(
    (a: ArtistRow) => {
      const willOpen = expanded !== a.name;
      setExpanded(willOpen ? a.name : null);
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
    try {
      await trackActions.playTracks(trackApi, ts, startId);
    } catch (err) {
      console.error("Failed to play:", err);
      pushToast("error", `再生に失敗しました: ${err}`);
    }
  }, [pushToast]);

  const enqueueTracks = useCallback(
    async (ts: Track[]) => {
      const ids = trackActions.playableIds(ts);
      if (ids.length === 0) return;
      try {
        await trackActions.enqueueTracks(trackApi, ids);
        pushToast("success", `${ids.length} 曲をキューに追加しました`);
      } catch (err) {
        pushToast("error", `キューへの追加に失敗しました: ${err}`);
      }
    },
    [pushToast],
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

  if (artists.length === 0 && !isLoading) {
    return (
      <div className="cb-grid-wrap">
        <EmptyState />
      </div>
    );
  }

  const items = rowVirtualizer.getVirtualItems();

  return (
    <div className="cb-grid-wrap" ref={setParentRef} onScroll={handleScroll}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
        {items.map((vRow) => {
          const row = rows[vRow.index];
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
                  {row.items.map((a) => {
                    const kt = knownArtistTracks(a);
                    const allIn = kt ? kt.length > 0 && kt.every((t) => crateSet.has(t.trackId)) : false;
                    const isCurrent = kt
                      ? kt.some((t) => playback.currentTrackId === t.trackId)
                      : false;
                    const isOpen = expanded === a.name;
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
                          onClick={() => toggleArtist(a)}
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
                          onClick={() => toggleArtist(a)}
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
                <ArtistExpansion
                  artist={row.item}
                  albums={albumCache.current.get(row.item.name) ?? null}
                  openAlbumKey={openAlbumKey}
                  tracksOf={(key) => trackCache.current.get(key) ?? null}
                  crateSet={crateSet}
                  currentTrackId={playback.currentTrackId}
                  onToggleAlbum={toggleAlbum}
                  onPlayArtist={() => artistTracks(row.item).then((ts) => playTracks(ts))}
                  onQueueArtist={() => artistTracks(row.item).then(enqueueTracks)}
                  onCrateArtist={() => artistTracks(row.item).then(crateTracks)}
                  onPlayAlbum={(al, startId) =>
                    ensureTracks(al.albumKey).then((ts) => playTracks(ts, startId))
                  }
                  onQueueAlbum={(al) => ensureTracks(al.albumKey).then(enqueueTracks)}
                  onCrateAlbum={(al) => ensureTracks(al.albumKey).then(crateTracks)}
                  onCrateTrack={addToCrate}
                  onClose={() => toggleArtist(row.item)}
                />
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
          <div className="cb-loading">Loading…</div>
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
                        {al.totalTimeMs > 0 ? ` · ${formatTime(al.totalTimeMs)}` : ""}
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
                      <div className="cb-loading">Loading…</div>
                    ) : (
                      <div className="cov-trks">
                        {tracks.map((t, i) => {
                          const isIn = crateSet.has(t.trackId);
                          const isCurrent = currentTrackId === t.trackId;
                          const showArtist = !!t.artist && t.artist !== artist.name;
                          return (
                            // 列は番号 / 曲名 / 長さ / +Crate のみ (ui-spec 3.2)。extra は渡さない。
                            <CovTrackRow
                              key={`${t.id}-${i}`}
                              track={t}
                              index={i}
                              isCurrent={isCurrent}
                              inCrate={isIn}
                              showArtist={showArtist}
                              time={formatTime(t.totalTimeMs)}
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
