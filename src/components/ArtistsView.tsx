import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as libraryApi from "../api/library";
import * as playbackApi from "../api/playback";
import * as audition from "../lib/audition";
import { Icon } from "./Icon";
import { ArtworkImg } from "./Cover";
import { artGradient, leadingGlyph } from "../lib/art";
import { ARTIST_SORT_FIELDS } from "../types";
import type { AlbumRow, ArtistRow, SortField, Track } from "../types";

const isTauri = "__TAURI_INTERNALS__" in window;

const GAP = 18;
const PAD_X = 20;
const MIN_CARD = 150;
const META_H = 46; // カード下のアーティスト名・件数ラベルのおよその高さ
/// サーバ集約を 1 ページずつ取る件数 (App.tsx のトラック取得と同じ粒度)。
const PAGE_SIZE = 500;

interface ArtistsViewProps {
  /// ライブラリ変更 (import / rip / 編集) のたびに増える値。変わったら取り直す。
  reloadKey: number;
}

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

const ARTIST_SORT_SET = new Set<string>(ARTIST_SORT_FIELDS);

type Row = { type: "grid"; artists: ArtistRow[] } | { type: "expand"; artist: ArtistRow };

/// アーティスト単位のブラウズビュー (viewMode = "artists")。
/// 集約はサーバ (`get_artists`) が行い、全曲をメモリに載せない。カードは仮想化し、
/// 展開するとそのアーティストのアルバム (`get_artist_albums`)、さらに展開すると
/// アルバムの曲 (`get_album_tracks`) を遅延取得する。
export function ArtistsView({ reloadKey }: ArtistsViewProps) {
  const { playback, crate, addToCrate, sortField, sortOrder } = useStore();
  const pushToast = useStore((s) => s.pushToast);

  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
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
  const loadingRef = useRef(false);
  // 取得のたびに増やす連番。応答が返ったとき最新でなければ (ソート変更などで
  // 後発のリクエストが走っていれば) その結果は捨てる。
  const reqSeq = useRef(0);

  // ツールバーのソートはアーティスト粒度の語彙だけ通す (他は name に倒す)。
  // store 側でもビュー切替時に正規化しているので、ここは保険。
  const artistSort: SortField = ARTIST_SORT_SET.has(sortField) ? sortField : "name";

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

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
        const rows = await libraryApi.getArtists(artistSort, sortOrder, PAGE_SIZE, offset);
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
    [artistSort, sortOrder, pushToast],
  );

  // ソート変更・ライブラリ変更で先頭から取り直す (キャッシュも捨てる)。
  useEffect(() => {
    setExpanded(null);
    setOpenAlbumKey(null);
    setHasMore(false);
    albumCache.current = new Map();
    trackCache.current = new Map();
    bumpCache();
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistSort, sortOrder, reloadKey]);

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

  const inner = Math.max(0, width - PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)) || 2);
  const cardW = Math.max(60, inner > 0 ? (inner - GAP * (cols - 1)) / cols : MIN_CARD);

  // グリッド行 (cols 枚ずつ) に、展開中アーティストの行を差し込んだ仮想行リスト。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < artists.length; i += cols) {
      const chunk = artists.slice(i, i + cols);
      out.push({ type: "grid", artists: chunk });
      for (const a of chunk) {
        if (expanded === a.name) out.push({ type: "expand", artist: a });
      }
    }
    return out;
  }, [artists, cols, expanded]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i].type === "grid" ? cardW + META_H + GAP : 260),
    overscan: 6,
    paddingStart: 18,
    paddingEnd: 18,
  });

  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardW, cols, expanded, openAlbumKey, cacheEpoch, rows.length]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) void load(false);
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
    const ids = ts.filter((t) => t.fileExists).map((t) => t.trackId);
    if (ids.length === 0) return;
    const start = startId != null ? Math.max(0, ids.indexOf(startId)) : 0;
    try {
      await audition.ensureNormalPlay();
      await playbackApi.setQueue(ids, start);
      await playbackApi.playTrack(ids[start]);
    } catch (err) {
      console.error("Failed to play:", err);
      pushToast("error", `再生に失敗しました: ${err}`);
    }
  }, [pushToast]);

  const enqueueTracks = useCallback(
    async (ts: Track[]) => {
      const ids = ts.filter((t) => t.fileExists).map((t) => t.trackId);
      if (ids.length === 0) return;
      try {
        for (const id of ids) await playbackApi.enqueueTrack(id);
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
        <div className="cb-empty">
          No tracks. Import an iTunes Library XML, rip a CD, or add files to get started.
        </div>
      </div>
    );
  }

  const items = rowVirtualizer.getVirtualItems();

  return (
    <div className="cb-grid-wrap" ref={parentRef} onScroll={handleScroll}>
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
                  {row.artists.map((a) => {
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
                          style={{ background: artGradient(a.name), height: cardW }}
                          onClick={() => toggleArtist(a)}
                          onDoubleClick={() => artistTracks(a).then((ts) => playTracks(ts))}
                        >
                          <span className="glyph">{leadingGlyph(a.name)}</span>
                          <ArtworkImg path={a.artworkLocationPath} />
                          <span className="grad" />
                          <div className="kbtag">
                            {a.albumCount > 1 && (
                              <span title={`${a.albumCount} albums`}>{a.albumCount}</span>
                            )}
                          </div>
                          <button
                            className="cov-play"
                            title="Play artist"
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
                              title="All in crate"
                            >
                              <Icon name="check" size={17} />
                            </span>
                          ) : (
                            <button
                              className="addbtn"
                              title="Add artist to crate"
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
                          title={`${a.name} — ${a.albumCount} albums · ${a.trackCount} tracks`}
                        >
                          <div className="cj">{a.name}</div>
                          <div className="la">
                            {a.trackCount} track{a.trackCount === 1 ? "" : "s"} ·{" "}
                            {a.albumCount} album{a.albumCount === 1 ? "" : "s"}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <ArtistExpansion
                  artist={row.artist}
                  albums={albumCache.current.get(row.artist.name) ?? null}
                  openAlbumKey={openAlbumKey}
                  tracksOf={(key) => trackCache.current.get(key) ?? null}
                  crateSet={crateSet}
                  currentTrackId={playback.currentTrackId}
                  onToggleAlbum={toggleAlbum}
                  onPlayArtist={() => artistTracks(row.artist).then((ts) => playTracks(ts))}
                  onQueueArtist={() => artistTracks(row.artist).then(enqueueTracks)}
                  onCrateArtist={() => artistTracks(row.artist).then(crateTracks)}
                  onPlayAlbum={(al, startId) =>
                    ensureTracks(al.albumKey).then((ts) => playTracks(ts, startId))
                  }
                  onQueueAlbum={(al) => ensureTracks(al.albumKey).then(enqueueTracks)}
                  onCrateAlbum={(al) => ensureTracks(al.albumKey).then(crateTracks)}
                  onCrateTrack={addToCrate}
                  onClose={() => toggleArtist(row.artist)}
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
            <span className="t">{artist.name}</span>
            <span className="s">
              {artist.albumCount} album{artist.albumCount === 1 ? "" : "s"} ·{" "}
              {artist.trackCount} track{artist.trackCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="art-exp-actions">
            <button className="cb-btn" title="Play all" onClick={onPlayArtist}>
              <Icon name="play" size={13} fill="currentColor" stroke={0} /> Play
            </button>
            <button className="cb-btn" title="Add all to queue" onClick={onQueueArtist}>
              <Icon name="list" size={13} /> Queue
            </button>
            <button className="cb-btn" title="Add all to crate" onClick={onCrateArtist}>
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
                      style={{ background: artGradient(al.album) }}
                    >
                      <span className="glyph">{leadingGlyph(al.album)}</span>
                      <ArtworkImg path={al.coverFileExists ? al.coverLocationPath : null} />
                    </div>
                    <div className="art-alb-meta">
                      <div className="t">{al.album}</div>
                      <div className="s">
                        {al.year != null ? `${al.year} · ` : ""}
                        {al.trackCount} track{al.trackCount === 1 ? "" : "s"}
                        {al.totalTimeMs > 0 ? ` · ${formatTime(al.totalTimeMs)}` : ""}
                      </div>
                    </div>
                    <button
                      className="art-alb-btn"
                      title="Play album"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayAlbum(al);
                      }}
                    >
                      <Icon name="play" size={14} fill="currentColor" stroke={0} />
                    </button>
                    <button
                      className="art-alb-btn"
                      title="Add album to queue"
                      onClick={(e) => {
                        e.stopPropagation();
                        onQueueAlbum(al);
                      }}
                    >
                      <Icon name="list" size={14} />
                    </button>
                    <button
                      className="art-alb-btn"
                      title="Add album to crate"
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
                            <div
                              key={t.id}
                              className={
                                "cov-trk" +
                                (isCurrent ? " play" : "") +
                                (!t.fileExists ? " missing" : "")
                              }
                              onDoubleClick={() => onPlayAlbum(al, t.trackId)}
                            >
                              <span className="n">{t.trackNumber ?? i + 1}</span>
                              <span className="nm">
                                {isCurrent && (
                                  <span className="cov-now">
                                    <Icon name="play" size={9} fill="currentColor" stroke={0} />
                                  </span>
                                )}
                                {!t.fileExists && (
                                  <span className="cb-warn" title="File not found">
                                    <Icon name="warning" size={11} />
                                  </span>
                                )}
                                <span className="ell">{t.name || "(unknown)"}</span>
                                {showArtist && <span className="sub"> — {t.artist}</span>}
                              </span>
                              <span className="tm cb-fmono">{formatTime(t.totalTimeMs)}</span>
                              {isIn ? (
                                <span className="cov-trk-add in" title="In crate">
                                  <Icon name="check" size={15} />
                                </span>
                              ) : (
                                <button
                                  className="cov-trk-add"
                                  title="Add to crate"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onCrateTrack(t);
                                  }}
                                >
                                  <Icon name="plus" size={15} />
                                </button>
                              )}
                            </div>
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
