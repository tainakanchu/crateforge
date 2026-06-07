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
import type { Track, Playlist } from "../types";

const GAP = 18;
const PAD_X = 20;
const MIN_CARD = 150;
const META_H = 46; // カード下のアルバム名・曲数ラベルのおよその高さ

interface CoversViewProps {
  onLoadMore: () => void;
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[]) => void;
}

interface CoversCtxMenu {
  x: number;
  y: number;
  album: AlbumGroup;
  trackIds: number[];
  primary: Track;
  headerLabel: string;
}

function ratingToStars(rating: number | null): number {
  if (!rating) return 0;
  return Math.round(rating / 20);
}

interface AlbumGroup {
  key: string;
  album: string;
  artist: string; // 表示用のアルバムアーティスト
  tracks: Track[];
  cover: Track; // アートワーク用の代表トラック
}

type Row =
  | { type: "grid"; albums: AlbumGroup[] }
  | { type: "expand"; album: AlbumGroup };

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// 同じアルバム（アルバムアーティスト＋アルバム名）のトラックを 1 グループへ。
// アルバム名が無い曲は 1 曲 1 カードとして扱う（巨大な「(unknown)」へ吸い込まれないように）。
function groupAlbums(tracks: Track[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>();
  const order: string[] = [];
  for (const t of tracks) {
    const albumName = (t.album || "").trim();
    const aa = (t.albumArtist || t.artist || "").trim();
    const key = albumName
      ? `al:${aa.toLowerCase()}␟${albumName.toLowerCase()}`
      : `tr:${t.trackId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        album: albumName || t.name || "(unknown)",
        artist: aa || t.artist || "",
        tracks: [],
        cover: t,
      };
      map.set(key, g);
      order.push(key);
    }
    g.tracks.push(t);
    if (!g.cover.fileExists && t.fileExists) g.cover = t;
  }
  // アルバム内はトラック番号順（番号が無いものは元の順序を保持）。
  for (const g of map.values()) {
    g.tracks.sort((a, b) => (a.trackNumber ?? 1e9) - (b.trackNumber ?? 1e9));
  }
  return order.map((k) => map.get(k)!);
}

/// アート前面のブラウズビュー。アルバム単位でまとめ、クリックで曲一覧を展開する。
export function CoversView({ onLoadMore, onTracksChanged, onEditTrack, onConvert }: CoversViewProps) {
  const {
    tracks,
    isLoading,
    hasMore,
    playback,
    crate,
    addToCrate,
    playlists,
    viewMode,
    selectedPlaylistId,
    recentPlaylistIds,
    pushRecentPlaylist,
    setSimilarBase,
  } = useStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<CoversCtxMenu | null>(null);
  const [showAddTagDialog, setShowAddTagDialog] = useState(false);
  const [newTag, setNewTag] = useState("");

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

  const albums = useMemo(() => groupAlbums(tracks), [tracks]);
  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  const inner = Math.max(0, width - PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)) || 2);
  const cardW = Math.max(60, inner > 0 ? (inner - GAP * (cols - 1)) / cols : MIN_CARD);

  // グリッド行（cols 枚ずつ）に、展開中アルバムの曲一覧行を差し込んだ仮想行リスト。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < albums.length; i += cols) {
      const chunk = albums.slice(i, i + cols);
      out.push({ type: "grid", albums: chunk });
      for (const al of chunk) {
        if (expanded.has(al.key)) out.push({ type: "expand", album: al });
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
    if (!el || isLoading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onLoadMore();
  }, [isLoading, hasMore, onLoadMore]);

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // アルバムを頭から（または指定トラックから）再生。
  const playAlbum = useCallback(async (album: AlbumGroup, startId?: number) => {
    const ids = album.tracks.filter((t) => t.fileExists).map((t) => t.trackId);
    if (ids.length === 0) return;
    const start = startId != null ? Math.max(0, ids.indexOf(startId)) : 0;
    try {
      await playbackApi.setQueue(ids, start);
      await playbackApi.playTrack(ids[start]);
    } catch (err) {
      console.error("Failed to play:", err);
    }
  }, []);

  const addAlbumToCrate = useCallback(
    (album: AlbumGroup) => {
      for (const t of album.tracks) addToCrate(t);
    },
    [addToCrate],
  );

  // ---- 右クリックメニュー ----
  const closeMenu = useCallback(() => setContextMenu(null), []);

  const openAlbumMenu = useCallback((e: React.MouseEvent, album: AlbumGroup) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      album,
      trackIds: album.tracks.map((t) => t.trackId),
      primary: album.tracks[0],
      headerLabel:
        album.tracks.length > 1 ? `${album.album} · ${album.tracks.length} tracks` : album.album,
    });
  }, []);

  const openTrackMenu = useCallback(
    (e: React.MouseEvent, album: AlbumGroup, track: Track) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        album,
        trackIds: [track.trackId],
        primary: track,
        headerLabel: track.name || "(unknown)",
      });
    },
    [],
  );

  const ctxTracks = useCallback(
    (ids: number[]): Track[] => {
      const set = new Set(ids);
      return tracks.filter((t) => set.has(t.trackId));
    },
    [tracks],
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
    ctxTracks(contextMenu.trackIds).forEach((t) => addToCrate(t));
    closeMenu();
  }, [contextMenu, ctxTracks, addToCrate, closeMenu]);

  const handleEnqueue = useCallback(async () => {
    if (!contextMenu) return;
    for (const id of contextMenu.trackIds) await playbackApi.enqueueTrack(id);
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
    const sel = ctxTracks(contextMenu.trackIds);
    onEditTrack(sel.length > 0 ? sel : [contextMenu.primary]);
    closeMenu();
  }, [contextMenu, ctxTracks, onEditTrack, closeMenu]);

  const handleAddToPlaylist = useCallback(
    async (playlistId: number) => {
      if (!contextMenu) return;
      try {
        await playlistsApi.addTracksToPlaylist(playlistId, contextMenu.trackIds);
        pushRecentPlaylist(playlistId);
        onTracksChanged();
      } catch (err) {
        alert(`Failed to add: ${err}`);
      }
      closeMenu();
    },
    [contextMenu, pushRecentPlaylist, onTracksChanged, closeMenu],
  );

  const handleRemoveFromPlaylist = useCallback(async () => {
    if (!contextMenu || viewMode !== "playlist" || selectedPlaylistId === null) return;
    try {
      for (const id of contextMenu.trackIds) {
        await playlistsApi.removeTrackFromPlaylist(selectedPlaylistId, id);
      }
      onTracksChanged();
    } catch (err) {
      alert(`Failed to remove: ${err}`);
    }
    closeMenu();
  }, [contextMenu, viewMode, selectedPlaylistId, onTracksChanged, closeMenu]);

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
      alert(`Failed: ${err}`);
    }
    setShowAddTagDialog(false);
    setNewTag("");
    closeMenu();
  }, [newTag, contextMenu, onTracksChanged, closeMenu]);

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      if (!contextMenu) return;
      try {
        await libraryApi.removeGenreTag(contextMenu.trackIds, tag);
        onTracksChanged();
      } catch (err) {
        alert(`Failed: ${err}`);
      }
      closeMenu();
    },
    [contextMenu, onTracksChanged, closeMenu],
  );

  // メニュー表示用の派生値（レーティングは最新の tracks から引き直す）。
  const ctxPrimary = contextMenu
    ? tracks.find((t) => t.trackId === contextMenu.primary.trackId) ?? contextMenu.primary
    : null;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxPrimary?.genre
    ? ctxPrimary.genre.split(/\s+/).filter(Boolean)
    : [];

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
                    const allIn = al.tracks.every((t) => crateSet.has(t.trackId));
                    const isCurrent = al.tracks.some(
                      (t) => playback.currentTrackId === t.trackId,
                    );
                    const isOpen = expanded.has(al.key);
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
                          onClick={() => toggleExpand(al.key)}
                          onDoubleClick={() => playAlbum(al)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                        >
                          <span className="glyph">{leadingGlyph(al.album)}</span>
                          <ArtworkImg path={al.cover.fileExists ? al.cover.locationPath : null} />
                          <span className="grad" />
                          <div className="kbtag">
                            {al.tracks.length > 1 && (
                              <span title={`${al.tracks.length} tracks`}>
                                {al.tracks.length}
                              </span>
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
                          onClick={() => toggleExpand(al.key)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                          title={`${al.album} — ${al.artist}`}
                        >
                          <div className="cj">{al.album}</div>
                          <div className="la">{al.artist}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <AlbumExpansion
                  album={row.album}
                  crateSet={crateSet}
                  currentTrackId={playback.currentTrackId}
                  onPlayTrack={(id) => playAlbum(row.album, id)}
                  onAddTrack={addToCrate}
                  onTrackContextMenu={(e, t) => openTrackMenu(e, row.album, t)}
                  onClose={() => toggleExpand(row.album.key)}
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
            playAlbum(contextMenu.album, contextMenu.primary.trackId);
            closeMenu();
          }}
          onSetRating={handleSetRating}
          onAddToCrate={handleAddToCrate}
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
  album: AlbumGroup;
  crateSet: Set<number>;
  currentTrackId: number | null;
  onPlayTrack: (trackId: number) => void;
  onAddTrack: (track: Track) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track) => void;
  onClose: () => void;
}

function AlbumExpansion({
  album,
  crateSet,
  currentTrackId,
  onPlayTrack,
  onAddTrack,
  onTrackContextMenu,
  onClose,
}: AlbumExpansionProps) {
  const totalMs = album.tracks.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
  return (
    // ラッパの padding で行間を確保する（margin だと getBoundingClientRect の
    // 計測高さに含まれず、仮想行が重なってしまうため）。
    <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
      <div className="cov-exp">
      <div className="cov-exp-head">
        <div className="cov-exp-title">
          <span className="t">{album.album}</span>
          <span className="s">
            {album.artist} · {album.tracks.length} tracks · {formatTime(totalMs)}
          </span>
        </div>
        <button className="cov-exp-close" title="Collapse" onClick={onClose}>
          <Icon name="chevronD" size={16} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
      <div className="cov-trks">
        {album.tracks.map((t, i) => {
          const isIn = crateSet.has(t.trackId);
          const isCurrent = currentTrackId === t.trackId;
          const showArtist = (t.artist || "") !== album.artist && !!t.artist;
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
