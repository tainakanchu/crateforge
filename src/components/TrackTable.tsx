import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import type { Track, ColumnKey, SortField, SortOrder } from "../types";
import { COLUMNS } from "../types";
import { ColumnPicker } from "./ColumnPicker";

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function ratingToStars(rating: number | null): number {
  if (!rating) return 0;
  return Math.round(rating / 20);
}

interface TrackTableProps {
  onLoadMore: () => void;
  onTracksChanged: () => void;
  onEditTrack: (track: Track) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  track: Track;
}

function getFieldForSort(t: Track, f: SortField): string | number | null {
  switch (f) {
    case "name":
      return t.name;
    case "artist":
      return t.artist;
    case "albumArtist":
      return t.albumArtist;
    case "album":
      return t.album;
    case "genre":
      return t.genre;
    case "rating":
      return t.rating;
    case "playCount":
      return t.playCount;
    case "year":
      return t.year;
    case "bpm":
      return t.bpm;
    case "trackNumber":
      return t.trackNumber;
    case "totalTimeMs":
      return t.totalTimeMs;
    case "dateAdded":
      return t.dateAdded;
  }
}

function compareForSort(a: Track, b: Track, field: SortField, order: SortOrder): number {
  const va = getFieldForSort(a, field);
  const vb = getFieldForSort(b, field);
  const sign = order === "asc" ? 1 : -1;
  // undefined/null sort last regardless of order
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
  return va.toString().localeCompare(vb.toString(), undefined, { sensitivity: "base" }) * sign;
}

export function TrackTable({ onLoadMore, onTracksChanged, onEditTrack }: TrackTableProps) {
  const {
    tracks,
    isLoading,
    hasMore,
    playback,
    selectedTrackIds,
    toggleTrackSelection,
    setSelectedTrackIds,
    playlists,
    viewMode,
    selectedPlaylistId,
    setSearchQuery,
    visibleColumns,
    sortField,
    sortOrder,
    toggleSort,
  } = useStore();

  const parentRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [showAddTagDialog, setShowAddTagDialog] = useState(false);
  const [newTag, setNewTag] = useState("");

  const orderedColumns = useMemo(
    () => COLUMNS.filter((c) => visibleColumns.includes(c.key)),
    [visibleColumns],
  );

  const sortedTracks = useMemo(() => {
    if (tracks.length === 0) return tracks;
    const arr = [...tracks];
    arr.sort((a, b) => compareForSort(a, b, sortField, sortOrder));
    return arr;
  }, [tracks, sortField, sortOrder]);

  const rowVirtualizer = useVirtualizer({
    count: sortedTracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      onLoadMore();
    }
  }, [isLoading, hasMore, onLoadMore]);

  const handleRowClick = useCallback(
    (e: React.MouseEvent, track: Track) => {
      const additive = e.ctrlKey || e.metaKey;
      if (e.shiftKey && selectedTrackIds.size > 0) {
        const lastSelectedTrackId = Array.from(selectedTrackIds).pop()!;
        const lastIdx = sortedTracks.findIndex((t) => t.trackId === lastSelectedTrackId);
        const curIdx = sortedTracks.findIndex((t) => t.trackId === track.trackId);
        if (lastIdx !== -1 && curIdx !== -1) {
          const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
          const next = new Set<number>(additive ? selectedTrackIds : new Set());
          for (let i = from; i <= to; i++) next.add(sortedTracks[i].trackId);
          setSelectedTrackIds(next);
          return;
        }
      }
      toggleTrackSelection(track.trackId, additive);
    },
    [sortedTracks, selectedTrackIds, setSelectedTrackIds, toggleTrackSelection],
  );

  const handleDoubleClick = useCallback(
    async (track: Track) => {
      if (!track.fileExists) return;
      try {
        // Set queue to the currently visible list, starting from the double-clicked track.
        const ids = sortedTracks.map((t) => t.trackId);
        const startIndex = ids.indexOf(track.trackId);
        await playbackApi.setQueue(ids, Math.max(0, startIndex));
        await playbackApi.playTrack(track.trackId);
      } catch (err) {
        console.error("Failed to play:", err);
      }
    },
    [sortedTracks],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, track: Track) => {
      e.preventDefault();
      if (!selectedTrackIds.has(track.trackId)) {
        toggleTrackSelection(track.trackId, false);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, track });
    },
    [selectedTrackIds, toggleTrackSelection],
  );

  const handleAddToPlaylist = useCallback(
    async (playlistId: number) => {
      const ids =
        selectedTrackIds.size > 0
          ? Array.from(selectedTrackIds)
          : contextMenu
            ? [contextMenu.track.trackId]
            : [];
      if (ids.length === 0) return;
      try {
        await playlistsApi.addTracksToPlaylist(playlistId, ids);
        onTracksChanged();
      } catch (err) {
        alert(`Failed to add: ${err}`);
      }
      setContextMenu(null);
    },
    [contextMenu, selectedTrackIds, onTracksChanged],
  );

  const handleRemoveFromPlaylist = useCallback(
    async (track: Track) => {
      if (viewMode !== "playlist" || selectedPlaylistId === null) return;
      const idx = sortedTracks.findIndex((t) => t.trackId === track.trackId);
      if (idx === -1) return;
      try {
        await playlistsApi.removeTrackFromPlaylist(selectedPlaylistId, idx);
        onTracksChanged();
      } catch (err) {
        alert(`Failed to remove: ${err}`);
      }
      setContextMenu(null);
    },
    [viewMode, selectedPlaylistId, sortedTracks, onTracksChanged],
  );

  const handleSetRating = useCallback(
    async (track: Track, stars: number) => {
      // Toggle off if clicking on the same star already set.
      const currentStars = ratingToStars(track.rating);
      const newRating = currentStars === stars ? 0 : stars * 20;
      try {
        await libraryApi.setTrackRating(track.trackId, newRating);
        onTracksChanged();
      } catch (err) {
        console.error("Failed to set rating:", err);
      }
    },
    [onTracksChanged],
  );

  const handleEnqueue = useCallback(async () => {
    const ids =
      selectedTrackIds.size > 0
        ? Array.from(selectedTrackIds)
        : contextMenu
          ? [contextMenu.track.trackId]
          : [];
    for (const id of ids) {
      await playbackApi.enqueueTrack(id);
    }
    setContextMenu(null);
  }, [contextMenu, selectedTrackIds]);

  const handleGenreChipClick = useCallback(
    (tag: string) => {
      setSearchQuery(tag);
    },
    [setSearchQuery],
  );

  const handleApplyAddTag = useCallback(async () => {
    const tag = newTag.trim();
    if (!tag) {
      setShowAddTagDialog(false);
      return;
    }
    const ids =
      selectedTrackIds.size > 0
        ? Array.from(selectedTrackIds)
        : contextMenu
          ? [contextMenu.track.trackId]
          : [];
    try {
      await libraryApi.addGenreTag(ids, tag);
      onTracksChanged();
    } catch (err) {
      alert(`Failed: ${err}`);
    }
    setShowAddTagDialog(false);
    setNewTag("");
    setContextMenu(null);
  }, [newTag, selectedTrackIds, contextMenu, onTracksChanged]);

  const handleRemoveGenreTag = useCallback(
    async (tag: string) => {
      const ids =
        selectedTrackIds.size > 0
          ? Array.from(selectedTrackIds)
          : contextMenu
            ? [contextMenu.track.trackId]
            : [];
      try {
        await libraryApi.removeGenreTag(ids, tag);
        onTracksChanged();
      } catch (err) {
        alert(`Failed: ${err}`);
      }
      setContextMenu(null);
    },
    [selectedTrackIds, contextMenu, onTracksChanged],
  );

  const handleGetInfo = useCallback(() => {
    if (!contextMenu) return;
    onEditTrack(contextMenu.track);
    setContextMenu(null);
  }, [contextMenu, onEditTrack]);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const items = rowVirtualizer.getVirtualItems();
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);

  const gridTemplate = orderedColumns.map((c) => c.width || "1fr").join(" ");

  // Tags currently shown in the context-menu target track's genre.
  const ctxGenreTags = contextMenu?.track.genre
    ? contextMenu.track.genre.split(/\s+/).filter(Boolean)
    : [];

  return (
    <div
      className="track-table-container"
      ref={parentRef}
      onScroll={handleScroll}
      onClick={closeMenu}
    >
      <div
        className="track-table-header"
        style={{ display: "grid", gridTemplateColumns: gridTemplate }}
      >
        {orderedColumns.map((col) => {
          const isSorted = col.sortField !== null && col.sortField === sortField;
          const indicator = isSorted ? (sortOrder === "asc" ? " ▲" : " ▼") : "";
          return (
            <div
              key={col.key}
              className={`col ${col.numeric ? "num" : ""} ${col.sortField ? "sortable" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (col.sortField) toggleSort(col.sortField);
              }}
            >
              {col.label}
              {indicator}
            </div>
          );
        })}
        <button
          className="col-picker-btn"
          title="Columns"
          onClick={(e) => {
            e.stopPropagation();
            setShowColumnPicker(true);
          }}
        >
          ⚙︎
        </button>
      </div>
      <div
        className="track-table-body"
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: "relative",
        }}
      >
        {items.map((virtualRow) => {
          const track = sortedTracks[virtualRow.index];
          const isCurrent = playback.currentTrackId === track.trackId;
          const isSelected = selectedTrackIds.has(track.trackId);
          return (
            <div
              key={track.id}
              className={`track-row ${isCurrent ? "playing" : ""} ${!track.fileExists ? "missing" : ""} ${isSelected ? "selected" : ""}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                display: "grid",
                gridTemplateColumns: gridTemplate,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onClick={(e) => handleRowClick(e, track)}
              onDoubleClick={() => handleDoubleClick(track)}
              onContextMenu={(e) => handleContextMenu(e, track)}
            >
              {orderedColumns.map((col) => (
                <Cell
                  key={col.key}
                  col={col.key}
                  track={track}
                  isCurrent={isCurrent}
                  onSetRating={handleSetRating}
                  onClickTag={handleGenreChipClick}
                />
              ))}
            </div>
          );
        })}
      </div>
      {isLoading && <div className="loading">Loading...</div>}
      {tracks.length === 0 && !isLoading && (
        <div className="empty">
          No tracks. Import an iTunes Library XML, rip a CD, or import files to get started.
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-header">
            {selectedTrackIds.size > 1
              ? `${selectedTrackIds.size} tracks selected`
              : contextMenu.track.name || "(unknown)"}
          </div>
          <div
            className="context-menu-item"
            onClick={() => handleDoubleClick(contextMenu.track)}
          >
            ▶ Play
          </div>
          <div className="context-menu-item" onClick={handleEnqueue}>
            ➕ Add to Queue
          </div>
          <div className="context-menu-item" onClick={handleGetInfo}>
            ℹ Get Info / Edit
          </div>
          {viewMode === "playlist" && (
            <div
              className="context-menu-item"
              onClick={() => handleRemoveFromPlaylist(contextMenu.track)}
            >
              − Remove from this playlist
            </div>
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-section">Add to playlist...</div>
          {targetPlaylists.length === 0 ? (
            <div className="context-menu-empty">No playlists yet</div>
          ) : (
            targetPlaylists.map((p) => (
              <div
                key={p.playlistId}
                className="context-menu-item"
                onClick={() => handleAddToPlaylist(p.playlistId)}
              >
                🎵 {p.name}
              </div>
            ))
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-section">Genre tags</div>
          <div
            className="context-menu-item"
            onClick={() => {
              setShowAddTagDialog(true);
            }}
          >
            ＋ Add tag…
          </div>
          {ctxGenreTags.map((tag) => (
            <div
              key={tag}
              className="context-menu-item"
              onClick={() => handleRemoveGenreTag(tag)}
            >
              − Remove "{tag}"
            </div>
          ))}
        </div>
      )}

      {showColumnPicker && (
        <ColumnPicker onClose={() => setShowColumnPicker(false)} />
      )}

      {showAddTagDialog && (
        <div className="modal-overlay" onClick={() => setShowAddTagDialog(false)}>
          <div
            className="modal"
            style={{ width: 360 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Add genre tag</h2>
              <button className="modal-close" onClick={() => setShowAddTagDialog(false)}>✕</button>
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
              <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
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

// === Cell renderer ===

interface CellProps {
  col: ColumnKey;
  track: Track;
  isCurrent: boolean;
  onSetRating: (track: Track, stars: number) => void;
  onClickTag: (tag: string) => void;
}

function Cell({ col, track, isCurrent, onSetRating, onClickTag }: CellProps) {
  switch (col) {
    case "name":
      return (
        <div className="col col-name">
          {!track.fileExists && (
            <span className="missing-icon" title="File not found">⚠</span>
          )}
          {isCurrent && <span className="playing-icon">▶</span>}
          {track.name || "(unknown)"}
        </div>
      );
    case "artist":
      return <div className="col">{track.artist || ""}</div>;
    case "albumArtist":
      return <div className="col">{track.albumArtist || ""}</div>;
    case "album":
      return <div className="col">{track.album || ""}</div>;
    case "genre":
      return (
        <div className="col col-genre">
          {(track.genre || "")
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => (
              <span
                key={t}
                className="genre-chip"
                onClick={(e) => {
                  e.stopPropagation();
                  onClickTag(t);
                }}
                title={`Filter by "${t}"`}
              >
                {t}
              </span>
            ))}
        </div>
      );
    case "year":
      return <div className="col num">{track.year ?? ""}</div>;
    case "rating": {
      const stars = ratingToStars(track.rating);
      return (
        <div className="col col-rating">
          {[1, 2, 3, 4, 5].map((s) => (
            <span
              key={s}
              className={`rating-star ${s <= stars ? "on" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSetRating(track, s);
              }}
            >
              {s <= stars ? "★" : "☆"}
            </span>
          ))}
        </div>
      );
    }
    case "playCount":
      return <div className="col num">{track.playCount ?? ""}</div>;
    case "bpm":
      return <div className="col num">{track.bpm ?? ""}</div>;
    case "totalTimeMs":
      return <div className="col num">{formatTime(track.totalTimeMs)}</div>;
    case "trackNumber":
      return <div className="col num">{track.trackNumber ?? ""}</div>;
    case "dateAdded":
      return <div className="col">{(track.dateAdded ?? "").slice(0, 10)}</div>;
  }
}
