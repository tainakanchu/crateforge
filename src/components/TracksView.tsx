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

type Row = { tracks: Track[] };

interface CtxMenu {
  x: number;
  y: number;
  track: Track;
}

interface TracksViewProps {
  onLoadMore: () => void;
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[]) => void;
}

const GAP = 18;
const PAD_X = 20;
const MIN_CARD = 150;
const META_H = 46;

export function TracksView({ onLoadMore, onTracksChanged, onEditTrack, onConvert }: TracksViewProps) {
  const {
    tracks,
    hasMore,
    isLoading,
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
  const pushToast = useStore((s) => s.pushToast);

  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null);
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

  const inner = Math.max(0, width - PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)) || 2);
  const cardW = Math.max(60, inner > 0 ? (inner - GAP * (cols - 1)) / cols : MIN_CARD);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < tracks.length; i += cols) {
      out.push({ tracks: tracks.slice(i, i + cols) });
    }
    return out;
  }, [tracks, cols]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cardW + META_H + GAP,
    overscan: 6,
    paddingStart: 18,
    paddingEnd: 18,
  });

  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardW, cols, rows.length]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onLoadMore();
  }, [isLoading, hasMore, onLoadMore]);

  const playTrack = useCallback(async (t: Track) => {
    const ids = tracks.filter((x) => x.fileExists).map((x) => x.trackId);
    if (ids.length === 0) return;
    const start = Math.max(0, ids.indexOf(t.trackId));
    try {
      await playbackApi.setQueue(ids, start);
      await playbackApi.playTrack(t.trackId);
    } catch (err) {
      console.error("Failed to play:", err);
    }
  }, [tracks]);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const openTrackMenu = useCallback((e: React.MouseEvent, t: Track) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, track: t });
  }, []);

  const handleSetRating = useCallback(async (stars: number) => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    try {
      await libraryApi.setTrackRating(id, stars * 20);
      onTracksChanged();
    } catch (err) {
      console.error("Failed to set rating:", err);
    }
  }, [contextMenu, onTracksChanged]);

  const handleAddToCrate = useCallback(() => {
    if (!contextMenu) return;
    addToCrate(contextMenu.track);
    closeMenu();
  }, [contextMenu, addToCrate, closeMenu]);

  const handleEnqueue = useCallback(async () => {
    if (!contextMenu) return;
    await playbackApi.enqueueTrack(contextMenu.track.trackId);
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handlePlayNext = useCallback(async () => {
    if (!contextMenu) return;
    await playbackApi.enqueueTrackNext(contextMenu.track.trackId);
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleAnalyze = useCallback(async () => {
    if (!contextMenu) return;
    try {
      await analysisApi.analyzeTracks([contextMenu.track.trackId], true);
    } catch (err) {
      console.error("Failed to queue analysis:", err);
    }
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleFindSimilar = useCallback(() => {
    if (!contextMenu) return;
    setSimilarBase(contextMenu.track.trackId);
    closeMenu();
  }, [contextMenu, setSimilarBase, closeMenu]);

  const handleConvert = useCallback(() => {
    if (!contextMenu) return;
    onConvert([contextMenu.track.trackId]);
    closeMenu();
  }, [contextMenu, onConvert, closeMenu]);

  const handleGetInfo = useCallback(() => {
    if (!contextMenu) return;
    onEditTrack([contextMenu.track]);
    closeMenu();
  }, [contextMenu, onEditTrack, closeMenu]);

  const handleAddToPlaylist = useCallback(async (playlistId: number) => {
    if (!contextMenu) return;
    try {
      await playlistsApi.addTracksToPlaylist(playlistId, [contextMenu.track.trackId]);
      pushRecentPlaylist(playlistId);
      onTracksChanged();
    } catch (err) {
      pushToast("error", `追加に失敗しました: ${err}`);
    }
    closeMenu();
  }, [contextMenu, pushRecentPlaylist, onTracksChanged, closeMenu, pushToast]);

  const handleRemoveFromPlaylist = useCallback(async () => {
    if (!contextMenu || viewMode !== "playlist" || selectedPlaylistId === null) return;
    try {
      await playlistsApi.removeTrackFromPlaylist(selectedPlaylistId, contextMenu.track.trackId);
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
      await libraryApi.addGenreTag([contextMenu.track.trackId], tag);
      onTracksChanged();
    } catch (err) {
      pushToast("error", `タグの追加に失敗しました: ${err}`);
    }
    setShowAddTagDialog(false);
    setNewTag("");
    closeMenu();
  }, [newTag, contextMenu, onTracksChanged, closeMenu, pushToast]);

  const handleRemoveTag = useCallback(async (tag: string) => {
    if (!contextMenu) return;
    try {
      await libraryApi.removeGenreTag([contextMenu.track.trackId], tag);
      onTracksChanged();
    } catch (err) {
      pushToast("error", `タグの削除に失敗しました: ${err}`);
    }
    closeMenu();
  }, [contextMenu, onTracksChanged, closeMenu, pushToast]);

  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  const ctxTrack = contextMenu
    ? tracks.find((t) => t.trackId === contextMenu.track.trackId) ?? contextMenu.track
    : null;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxTrack?.genre ? ctxTrack.genre.split(/\s+/).filter(Boolean) : [];

  if (tracks.length === 0 && !isLoading) {
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
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  gap: GAP,
                  padding: `0 ${PAD_X}px ${GAP}px`,
                }}
              >
                {row.tracks.map((t) => {
                  const inCrate = crateSet.has(t.trackId);
                  const isCurrent = playback.currentTrackId === t.trackId;
                  return (
                    <div key={t.id} className="cb-cardwrap">
                      <div
                        className={"cb-card" + (inCrate ? " incrate" : "") + (isCurrent ? " playing" : "")}
                        style={{ background: artGradient(t.album || t.name || ""), height: cardW }}
                        onDoubleClick={() => void playTrack(t)}
                        onContextMenu={(e) => openTrackMenu(e, t)}
                      >
                        <span className="glyph">{leadingGlyph(t.album || t.name || "")}</span>
                        <ArtworkImg path={t.fileExists ? t.locationPath : null} />
                        <span className="grad" />
                        {t.bpm != null && (
                          <div className="kbtag">
                            <span style={{ color: bpmColor(t.bpm) }}>{t.bpm}</span>
                          </div>
                        )}
                        <button
                          className="cov-play"
                          title="Play track"
                          onClick={(e) => {
                            e.stopPropagation();
                            void playTrack(t);
                          }}
                        >
                          <Icon name="play" size={20} fill="currentColor" stroke={0} />
                        </button>
                        {inCrate ? (
                          <span
                            className="addbtn"
                            style={{ opacity: 1, transform: "none" }}
                            title="In crate"
                          >
                            <Icon name="check" size={17} />
                          </span>
                        ) : (
                          <button
                            className="addbtn"
                            title="Add to crate"
                            onClick={(e) => {
                              e.stopPropagation();
                              addToCrate(t);
                            }}
                          >
                            <Icon name="plus" size={17} />
                          </button>
                        )}
                      </div>
                      <div
                        className="cov-meta"
                        onDoubleClick={() => void playTrack(t)}
                        onContextMenu={(e) => openTrackMenu(e, t)}
                        title={`${t.name || "(unknown)"} — ${t.artist || ""}`}
                      >
                        <div className="cj">{t.name || "(unknown)"}</div>
                        <div className="la">{t.artist || ""}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {isLoading && <div className="cb-loading">Loading…</div>}

      {contextMenu && ctxTrack && (
        <TrackContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          headerLabel={ctxTrack.name || "(unknown)"}
          ratingStars={ctxTrack.rating ? Math.round(ctxTrack.rating / 20) : 0}
          genreTags={ctxGenreTags}
          playlists={playlists}
          recentPlaylists={recentPlaylists}
          showRemoveFromPlaylist={viewMode === "playlist"}
          onClose={closeMenu}
          onPlay={() => { void playTrack(contextMenu.track); closeMenu(); }}
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
                  if (e.key === "Enter") void handleApplyAddTag();
                  if (e.key === "Escape") setShowAddTagDialog(false);
                }}
                style={{ width: "100%" }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
                <button className="toolbar-btn" onClick={() => setShowAddTagDialog(false)}>
                  Cancel
                </button>
                <button className="toolbar-btn primary" onClick={() => void handleApplyAddTag()}>
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
