import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon } from "./Icon";
import { ArtworkImg } from "./Cover";
import { TrackContextMenu } from "./TrackContextMenu";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import type { Track, Playlist, AlbumRow } from "../types";

const GAP = 18;
const PAD_X = 20;
const MIN_CARD = 150;
const META_H = 46; // カード下のアルバム名・曲数ラベルのおよその高さ

interface AlbumsViewProps {
  onLoadMore: () => void;
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[]) => void;
}

// 描画用に正規化したアルバム1枚分の情報。ライブラリスコープ (サーバ集約 AlbumRow) と
// スコープ外 (クライアント束ね) の2系統入力を1本化する。
interface AlbumVM {
  key: string;
  album: string;
  albumArtist: string; // コンピは "Various Artists"
  isCompilation: boolean;
  trackCount: number;
  coverTrackId: number | null;
  coverPath: string | null; // file_exists でなければ null
  totalTimeMs: number;
  bpmMin: number | null;
  bpmMax: number | null;
  // null = 未取得 (ライブラリ; 展開・操作時に getAlbumTracks で遅延取得)、
  // 配列 = 取得済み (スコープ外のクライアント束ね)。
  tracks: Track[] | null;
}

interface CoversCtxMenu {
  x: number;
  y: number;
  albumKey: string;
  tracks: Track[];
  trackIds: number[];
  primary: Track;
  headerLabel: string;
}

function ratingToStars(rating: number | null): number {
  if (!rating) return 0;
  return Math.round(rating / 20);
}

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// サーバ集約の AlbumRow を描画用 AlbumVM へ。曲は展開時に遅延取得するので tracks=null。
function albumRowToVM(r: AlbumRow): AlbumVM {
  return {
    key: r.albumKey,
    album: r.album || "(unknown)",
    albumArtist: r.albumArtist,
    isCompilation: r.isCompilation,
    trackCount: r.trackCount,
    coverTrackId: r.coverTrackId,
    coverPath: r.coverFileExists ? r.coverLocationPath : null,
    totalTimeMs: r.totalTimeMs,
    bpmMin: r.bpmMin,
    bpmMax: r.bpmMax,
    tracks: null,
  };
}

// ロード済みトラックをクライアント側でアルバム単位に束ねる (スコープ外: プレイリスト/検索/最近)。
// 束ねキー:
//   compilation → cmp:<album>            (アルバムアーティストが違っても album だけで束ねる)
//   album 空    → tr:<trackId>           (巨大な「(unknown)」へ吸い込まれないように)
//   それ以外    → al:<albumArtist|artist>␟<album>
// アルバム内は disc→track 順 (multi-disc を正しく並べる)。
function groupAlbums(tracks: Track[]): AlbumVM[] {
  const map = new Map<string, { vm: AlbumVM; cover: Track | null }>();
  const order: string[] = [];
  for (const t of tracks) {
    const albumName = (t.album || "").trim();
    const isCmp = t.compilation === true;
    const key = isCmp
      ? `cmp:${albumName.toLowerCase()}`
      : !albumName
        ? `tr:${t.trackId}`
        : `al:${(t.albumArtist || t.artist || "").toLowerCase()}␟${albumName.toLowerCase()}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        vm: {
          key,
          album: albumName || t.name || "(unknown)",
          albumArtist: isCmp ? "Various Artists" : t.albumArtist || t.artist || "",
          isCompilation: isCmp,
          trackCount: 0,
          coverTrackId: null,
          coverPath: null,
          totalTimeMs: 0,
          bpmMin: null,
          bpmMax: null,
          tracks: [],
        },
        cover: null,
      };
      map.set(key, entry);
      order.push(key);
    }
    entry.vm.tracks!.push(t);
    // カバー代表曲は file_exists を優先 (先頭曲 → 最初の実在曲へ昇格)。
    if (!entry.cover || (!entry.cover.fileExists && t.fileExists)) entry.cover = t;
  }
  const out: AlbumVM[] = [];
  for (const key of order) {
    const { vm, cover } = map.get(key)!;
    const ts = vm.tracks!;
    // disc→track 順。番号が無いものは末尾へ。
    ts.sort((a, b) => {
      const av = (a.discNumber ?? 0) * 100000 + (a.trackNumber ?? 1e9);
      const bv = (b.discNumber ?? 0) * 100000 + (b.trackNumber ?? 1e9);
      return av - bv;
    });
    vm.trackCount = ts.length;
    vm.totalTimeMs = ts.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
    const bpms = ts.map((t) => t.bpm).filter((b): b is number => b != null);
    vm.bpmMin = bpms.length ? Math.min(...bpms) : null;
    vm.bpmMax = bpms.length ? Math.max(...bpms) : null;
    vm.coverTrackId = cover?.trackId ?? null;
    vm.coverPath = cover && cover.fileExists ? cover.locationPath : null;
    out.push(vm);
  }
  return out;
}

type Row = { type: "grid"; albums: AlbumVM[] } | { type: "expand"; album: AlbumVM };

/// アート前面のブラウズビュー。アルバム単位でまとめ、クリックで曲一覧を展開する。
/// 入力は2系統:
///  - ライブラリスコープ (検索なしの全ライブラリ): store.albums (サーバ集約) を表示し、
///    曲は展開・操作時に getAlbumTracks で遅延取得してキャッシュする。
///  - スコープ外 (プレイリスト/検索/最近): ロード済み tracks をクライアント束ねする。
export function AlbumsView({ onLoadMore, onTracksChanged, onEditTrack, onConvert }: AlbumsViewProps) {
  const {
    tracks,
    albums: storeAlbums,
    albumsHasMore,
    hasMore,
    isLoading,
    playback,
    crate,
    addToCrate,
    playlists,
    viewMode,
    selectedPlaylistId,
    searchQuery,
    filterTags,
    recentPlaylistIds,
    pushRecentPlaylist,
    setSimilarBase,
  } = useStore();
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<CoversCtxMenu | null>(null);
  const [showAddTagDialog, setShowAddTagDialog] = useState(false);
  const [newTag, setNewTag] = useState("");
  // ライブラリスコープの遅延取得キャッシュ (albumKey → tracks)。
  const [trackCache, setTrackCache] = useState<Map<string, Track[]>>(new Map());

  // スコープ判定: 検索なしのライブラリ全体ならサーバ集約 (store.albums) を使う。
  const combinedQuery = [searchQuery.trim(), ...filterTags].filter(Boolean).join(" ");
  const isLibraryScope = viewMode === "library" && !combinedQuery;

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

  const albums = useMemo<AlbumVM[]>(
    () => (isLibraryScope ? storeAlbums.map(albumRowToVM) : groupAlbums(tracks)),
    [isLibraryScope, storeAlbums, tracks],
  );
  const moreAvailable = isLibraryScope ? albumsHasMore : hasMore;
  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  // vm の曲が手元にあれば返す (クライアント束ね=常にあり、ライブラリ=取得済みならキャッシュから)。
  const knownTracks = useCallback(
    (vm: AlbumVM): Track[] | null => vm.tracks ?? trackCache.get(vm.key) ?? null,
    [trackCache],
  );

  // ライブラリスコープのアルバムの曲を遅延取得してキャッシュする。
  const ensureTracks = useCallback(
    async (vm: AlbumVM): Promise<Track[]> => {
      if (vm.tracks) return vm.tracks;
      const cached = trackCache.get(vm.key);
      if (cached) return cached;
      try {
        const ts = await libraryApi.getAlbumTracks(vm.key);
        setTrackCache((prev) => {
          const next = new Map(prev);
          next.set(vm.key, ts);
          return next;
        });
        return ts;
      } catch (err) {
        console.error("Failed to load album tracks:", err);
        return [];
      }
    },
    [trackCache],
  );

  const inner = Math.max(0, width - PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)) || 2);
  const cardW = Math.max(60, inner > 0 ? (inner - GAP * (cols - 1)) / cols : MIN_CARD);

  // グリッド行 (cols 枚ずつ) に、展開中アルバムの曲一覧行を差し込んだ仮想行リスト。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < albums.length; i += cols) {
      const chunk = albums.slice(i, i + cols);
      out.push({ type: "grid", albums: chunk });
      for (const al of chunk) {
        if (expanded === al.key) out.push({ type: "expand", album: al });
      }
    }
    return out;
  }, [albums, cols, expanded]);

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
  }, [cardW, cols, expanded, rows.length]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !moreAvailable) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onLoadMore();
  }, [isLoading, moreAvailable, onLoadMore]);

  const toggleExpand = useCallback(
    (vm: AlbumVM) => {
      const willOpen = expanded !== vm.key;
      setExpanded(willOpen ? vm.key : null);
      // 開くなら曲を先取り (キャッシュ済みなら no-op)。
      if (willOpen && vm.tracks == null) void ensureTracks(vm);
    },
    [expanded, ensureTracks],
  );

  // 解決済みトラックを頭から (または指定トラックから) 再生。
  const playTracks = useCallback(async (ts: Track[], startId?: number) => {
    const ids = ts.filter((t) => t.fileExists).map((t) => t.trackId);
    if (ids.length === 0) return;
    const start = startId != null ? Math.max(0, ids.indexOf(startId)) : 0;
    try {
      await playbackApi.setQueue(ids, start);
      await playbackApi.playTrack(ids[start]);
    } catch (err) {
      console.error("Failed to play:", err);
    }
  }, []);

  // アルバムを再生 (必要なら曲を取得してから)。
  const playAlbum = useCallback(
    async (vm: AlbumVM, startId?: number) => {
      const ts = await ensureTracks(vm);
      await playTracks(ts, startId);
    },
    [ensureTracks, playTracks],
  );

  const addAlbumToCrate = useCallback(
    async (vm: AlbumVM) => {
      const ts = await ensureTracks(vm);
      for (const t of ts) addToCrate(t);
    },
    [ensureTracks, addToCrate],
  );

  // ---- 右クリックメニュー ----
  const closeMenu = useCallback(() => setContextMenu(null), []);

  const openAlbumMenu = useCallback(
    async (e: React.MouseEvent, vm: AlbumVM) => {
      e.preventDefault();
      e.stopPropagation();
      // await をまたぐので座標は先に取り出しておく。
      const x = e.clientX;
      const y = e.clientY;
      const ts = await ensureTracks(vm);
      if (ts.length === 0) return;
      setContextMenu({
        x,
        y,
        albumKey: vm.key,
        tracks: ts,
        trackIds: ts.map((t) => t.trackId),
        primary: ts[0],
        headerLabel: ts.length > 1 ? `${vm.album} · ${ts.length} tracks` : vm.album,
      });
    },
    [ensureTracks],
  );

  const openTrackMenu = useCallback(
    (e: React.MouseEvent, albumTracks: Track[], albumKey: string, track: Track) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        albumKey,
        tracks: albumTracks,
        trackIds: [track.trackId],
        primary: track,
        headerLabel: track.name || "(unknown)",
      });
    },
    [],
  );

  const handleSetRating = useCallback(
    async (stars: number) => {
      if (!contextMenu) return;
      const rating = stars * 20;
      try {
        for (const id of contextMenu.trackIds) await libraryApi.setTrackRating(id, rating);
        onTracksChanged();
      } catch (err) {
        console.error("Failed to set rating:", err);
      }
    },
    [contextMenu, onTracksChanged],
  );

  const handleAddToCrate = useCallback(() => {
    if (!contextMenu) return;
    contextMenu.tracks.forEach((t) => addToCrate(t));
    closeMenu();
  }, [contextMenu, addToCrate, closeMenu]);

  const handleEnqueue = useCallback(async () => {
    if (!contextMenu) return;
    for (const id of contextMenu.trackIds) await playbackApi.enqueueTrack(id);
    closeMenu();
  }, [contextMenu, closeMenu]);

  // 「次に再生」: enqueueTrackNext は現在曲の直後へ1曲ずつ挿入するため、
  // 反転してから入れると最終的な並びが選択順どおりになる。
  const handlePlayNext = useCallback(async () => {
    if (!contextMenu) return;
    for (const id of [...contextMenu.trackIds].reverse()) {
      await playbackApi.enqueueTrackNext(id);
    }
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleAnalyze = useCallback(async () => {
    if (!contextMenu) return;
    try {
      await analysisApi.analyzeTracks(contextMenu.trackIds, true);
    } catch (err) {
      console.error("Failed to queue analysis:", err);
    }
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleFindSimilar = useCallback(() => {
    if (!contextMenu) return;
    setSimilarBase(contextMenu.primary.trackId);
    closeMenu();
  }, [contextMenu, setSimilarBase, closeMenu]);

  const handleConvert = useCallback(() => {
    if (!contextMenu) return;
    onConvert(contextMenu.trackIds);
    closeMenu();
  }, [contextMenu, onConvert, closeMenu]);

  const handleGetInfo = useCallback(() => {
    if (!contextMenu) return;
    onEditTrack(contextMenu.tracks.length > 0 ? contextMenu.tracks : [contextMenu.primary]);
    closeMenu();
  }, [contextMenu, onEditTrack, closeMenu]);

  const handleAddToPlaylist = useCallback(
    async (playlistId: number) => {
      if (!contextMenu) return;
      try {
        await playlistsApi.addTracksToPlaylist(playlistId, contextMenu.trackIds);
        pushRecentPlaylist(playlistId);
        onTracksChanged();
      } catch (err) {
        pushToast("error", `追加に失敗しました: ${err}`);
      }
      closeMenu();
    },
    [contextMenu, pushRecentPlaylist, onTracksChanged, closeMenu, pushToast],
  );

  const handleRemoveFromPlaylist = useCallback(async () => {
    if (!contextMenu || viewMode !== "playlist" || selectedPlaylistId === null) return;
    try {
      for (const id of contextMenu.trackIds) {
        await playlistsApi.removeTrackFromPlaylist(selectedPlaylistId, id);
      }
      onTracksChanged();
    } catch (err) {
      pushToast("error", `削除に失敗しました: ${err}`);
    }
    closeMenu();
  }, [contextMenu, viewMode, selectedPlaylistId, onTracksChanged, closeMenu, pushToast]);

  const handleApplyAddTag = useCallback(async () => {
    const tag = newTag.trim();
    if (!tag || !contextMenu) {
      setShowAddTagDialog(false);
      return;
    }
    try {
      await libraryApi.addGenreTag(contextMenu.trackIds, tag);
      onTracksChanged();
    } catch (err) {
      pushToast("error", `タグの追加に失敗しました: ${err}`);
    }
    setShowAddTagDialog(false);
    setNewTag("");
    closeMenu();
  }, [newTag, contextMenu, onTracksChanged, closeMenu, pushToast]);

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      if (!contextMenu) return;
      try {
        await libraryApi.removeGenreTag(contextMenu.trackIds, tag);
        onTracksChanged();
      } catch (err) {
        pushToast("error", `タグの削除に失敗しました: ${err}`);
      }
      closeMenu();
    },
    [contextMenu, onTracksChanged, closeMenu, pushToast],
  );

  // メニュー表示用の派生値 (レーティングは最新の tracks から引き直す)。
  const ctxPrimary = contextMenu
    ? tracks.find((t) => t.trackId === contextMenu.primary.trackId) ?? contextMenu.primary
    : null;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxPrimary?.genre ? ctxPrimary.genre.split(/\s+/).filter(Boolean) : [];

  if (albums.length === 0 && !isLoading) {
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
    <div className="cb-grid-wrap" ref={parentRef} onScroll={handleScroll} onClick={closeMenu}>
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
                    // minmax(0,1fr): 列がコンテンツ最小幅で膨張する grid blowout を防ぐ
                    // （アルバム名ラベルの折り返さない CJK 文字で起きていた）。
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    gap: GAP,
                    padding: `0 ${PAD_X}px ${GAP}px`,
                  }}
                >
                  {row.albums.map((al) => {
                    const kt = knownTracks(al);
                    const allIn = kt ? kt.length > 0 && kt.every((t) => crateSet.has(t.trackId)) : false;
                    const isCurrent = kt ? kt.some((t) => playback.currentTrackId === t.trackId) : false;
                    const isOpen = expanded === al.key;
                    return (
                      <div key={al.key} className="cb-cardwrap">
                        <div
                          className={
                            "cb-card" +
                            (allIn ? " incrate" : "") +
                            (isCurrent ? " playing" : "") +
                            (isOpen ? " opened" : "")
                          }
                          style={{ background: artGradient(al.album), height: cardW }}
                          onClick={() => toggleExpand(al)}
                          onDoubleClick={() => playAlbum(al)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                        >
                          <span className="glyph">{leadingGlyph(al.album)}</span>
                          <ArtworkImg path={al.coverPath} />
                          <span className="grad" />
                          <div className="kbtag">
                            {al.trackCount > 1 && (
                              <span title={`${al.trackCount} tracks`}>{al.trackCount}</span>
                            )}
                          </div>
                          <button
                            className="cov-play"
                            title="Play album"
                            onClick={(e) => {
                              e.stopPropagation();
                              playAlbum(al);
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
                              title="Add album to crate"
                              onClick={(e) => {
                                e.stopPropagation();
                                addAlbumToCrate(al);
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
                          onClick={() => toggleExpand(al)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                          title={`${al.album} — ${al.albumArtist}`}
                        >
                          <div className="cj">{al.album}</div>
                          <div className="la">{al.albumArtist}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <AlbumExpansion
                  vm={row.album}
                  tracks={knownTracks(row.album)}
                  crateSet={crateSet}
                  currentTrackId={playback.currentTrackId}
                  onPlayTrack={(id) => playAlbum(row.album, id)}
                  onAddTrack={addToCrate}
                  onTrackContextMenu={(e, t) =>
                    openTrackMenu(e, knownTracks(row.album) ?? [], row.album.key, t)
                  }
                  onClose={() => toggleExpand(row.album)}
                />
              )}
            </div>
          );
        })}
      </div>
      {isLoading && <div className="cb-loading">Loading…</div>}

      {contextMenu && ctxPrimary && (
        <TrackContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          headerLabel={contextMenu.headerLabel}
          ratingStars={ratingToStars(ctxPrimary.rating)}
          genreTags={ctxGenreTags}
          playlists={playlists}
          recentPlaylists={recentPlaylists}
          showRemoveFromPlaylist={viewMode === "playlist"}
          onClose={closeMenu}
          onPlay={() => {
            void playTracks(contextMenu.tracks, contextMenu.primary.trackId);
            closeMenu();
          }}
          onSetRating={handleSetRating}
          onAddToCrate={handleAddToCrate}
          onPlayNext={handlePlayNext}
          onEnqueue={handleEnqueue}
          onAnalyze={handleAnalyze}
          onFindSimilar={handleFindSimilar}
          onConvert={handleConvert}
          onGetInfo={handleGetInfo}
          onRemoveFromPlaylist={handleRemoveFromPlaylist}
          onAddToPlaylist={handleAddToPlaylist}
          onAddTag={() => setShowAddTagDialog(true)}
          onRemoveTag={handleRemoveTag}
        />
      )}

      {showAddTagDialog && (
        <div className="modal-overlay" onClick={() => setShowAddTagDialog(false)}>
          <div className="modal" style={{ width: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                <Icon name="tag" size={16} /> Add genre tag
              </h2>
              <button className="modal-close" onClick={() => setShowAddTagDialog(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: 16 }}>
              <input
                autoFocus
                type="text"
                className="rip-input"
                placeholder="e.g. House"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleApplyAddTag();
                  if (e.key === "Escape") setShowAddTagDialog(false);
                }}
                style={{ width: "100%" }}
              />
              <div
                style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}
              >
                <button className="toolbar-btn" onClick={() => setShowAddTagDialog(false)}>
                  Cancel
                </button>
                <button className="toolbar-btn primary" onClick={handleApplyAddTag}>
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AlbumExpansionProps {
  vm: AlbumVM;
  tracks: Track[] | null;
  crateSet: Set<number>;
  currentTrackId: number | null;
  onPlayTrack: (trackId: number) => void;
  onAddTrack: (track: Track) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track) => void;
  onClose: () => void;
}

function AlbumExpansion({
  vm,
  tracks,
  crateSet,
  currentTrackId,
  onPlayTrack,
  onAddTrack,
  onTrackContextMenu,
  onClose,
}: AlbumExpansionProps) {
  // ライブラリスコープでは曲を遅延取得中の場合がある。
  if (!tracks) {
    return (
      <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
        <div className="cov-exp">
          <div className="cb-loading">Loading…</div>
        </div>
      </div>
    );
  }
  const totalMs = tracks.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
  return (
    // ラッパの padding で行間を確保する（margin だと getBoundingClientRect の
    // 計測高さに含まれず、仮想行が重なってしまうため）。
    <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
      <div className="cov-exp">
      <div className="cov-exp-head">
        <div className="cov-exp-title">
          <span className="t">{vm.album}</span>
          <span className="s">
            {vm.albumArtist} · {tracks.length} tracks · {formatTime(totalMs)}
          </span>
        </div>
        <button className="cov-exp-close" title="Collapse" onClick={onClose}>
          <Icon name="chevronD" size={16} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
      <div className="cov-trks">
        {tracks.map((t, i) => {
          const isIn = crateSet.has(t.trackId);
          const isCurrent = currentTrackId === t.trackId;
          const showArtist = (t.artist || "") !== vm.albumArtist && !!t.artist;
          return (
            <div
              key={t.id}
              className={"cov-trk" + (isCurrent ? " play" : "") + (!t.fileExists ? " missing" : "")}
              onDoubleClick={() => onPlayTrack(t.trackId)}
              onContextMenu={(e) => onTrackContextMenu(e, t)}
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
              {t.bpm != null && (
                <span className="bpm cb-fmono" style={{ color: bpmColor(t.bpm) }}>
                  {t.bpm}
                </span>
              )}
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
                    onAddTrack(t);
                  }}
                >
                  <Icon name="plus" size={15} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
