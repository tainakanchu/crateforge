import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon, Stars } from "./Icon";
import { Cover } from "./Cover";
import { TrackContextMenu } from "./TrackContextMenu";
import { GenreTagInput } from "./GenreTagInput";
import { bpmColor } from "../lib/art";
import { FIELD_DEFS } from "../types";
import type { Track, FieldKey, Playlist } from "../types";

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
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[]) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  track: Track;
}

interface GenreEditState {
  trackId: number;
  x: number;
  y: number;
  tags: string[];
}

export function TrackTable({ onLoadMore, onTracksChanged, onEditTrack, onConvert }: TrackTableProps) {
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
    addFilterTag,
    fields,
    rowH,
    coverSize,
    sortField,
    sortOrder,
    toggleSort,
    crate,
    addToCrate,
    recentPlaylistIds,
    pushRecentPlaylist,
    analysisByTrack,
    setSimilarBase,
  } = useStore();

  const parentRef = useRef<HTMLDivElement>(null);
  // 範囲選択の起点（Shift の基準）と、矢印移動のカーソル位置。
  const anchorIdRef = useRef<number | null>(null);
  const focusIdRef = useRef<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showAddTagDialog, setShowAddTagDialog] = useState(false);
  const [newTag, setNewTag] = useState("");
  // 一覧からのジャンル直接編集（ポップオーバー）。
  const [genreEdit, setGenreEdit] = useState<GenreEditState | null>(null);
  const [genreSuggestions, setGenreSuggestions] = useState<string[]>([]);

  const inCrate = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);
  const showArtist = rowH >= 50;
  const nameFontSize = rowH < 44 ? 13 : 14.5;

  const rowVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 16,
  });
  // キーボード操作（空 deps の effect）から最新の virtualizer を参照するための ref。
  const virtualizerRef = useRef(rowVirtualizer);
  virtualizerRef.current = rowVirtualizer;

  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowH]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
      onLoadMore();
    }
  }, [isLoading, hasMore, onLoadMore]);

  const handleRowClick = useCallback(
    (e: React.MouseEvent, track: Track) => {
      const additive = e.ctrlKey || e.metaKey;
      if (e.shiftKey) {
        // アンカー（前回クリック位置）から今回までを範囲選択。アンカーは
        // 動かさないので、Shift クリックを繰り返すと同じ起点から伸縮できる。
        const anchorId = anchorIdRef.current ?? track.trackId;
        const anchorIdx = tracks.findIndex((t) => t.trackId === anchorId);
        const curIdx = tracks.findIndex((t) => t.trackId === track.trackId);
        if (anchorIdx !== -1 && curIdx !== -1) {
          const [from, to] = anchorIdx <= curIdx ? [anchorIdx, curIdx] : [curIdx, anchorIdx];
          // Shift+Ctrl/Cmd は既存選択へ追加、ただの Shift は置き換え。
          const next = new Set<number>(additive ? selectedTrackIds : new Set<number>());
          for (let i = from; i <= to; i++) next.add(tracks[i].trackId);
          setSelectedTrackIds(next);
          if (anchorIdRef.current === null) anchorIdRef.current = anchorId;
          focusIdRef.current = track.trackId;
          return;
        }
      }
      // 通常クリック / Ctrl・Cmd クリック: アンカーとフォーカスをここへ移す。
      anchorIdRef.current = track.trackId;
      focusIdRef.current = track.trackId;
      toggleTrackSelection(track.trackId, additive);
    },
    [tracks, selectedTrackIds, setSelectedTrackIds, toggleTrackSelection],
  );

  const handleDoubleClick = useCallback(
    async (track: Track) => {
      if (!track.fileExists) return;
      try {
        const ids = tracks.map((t) => t.trackId);
        const startIndex = ids.indexOf(track.trackId);
        await playbackApi.setQueue(ids, Math.max(0, startIndex));
        await playbackApi.playTrack(track.trackId);
      } catch (err) {
        console.error("Failed to play:", err);
      }
    },
    [tracks],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, track: Track) => {
      e.preventDefault();
      if (!selectedTrackIds.has(track.trackId)) {
        anchorIdRef.current = track.trackId;
        focusIdRef.current = track.trackId;
        toggleTrackSelection(track.trackId, false);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, track });
    },
    [selectedTrackIds, toggleTrackSelection],
  );

  const ctxIds = useCallback((): number[] => {
    return selectedTrackIds.size > 0
      ? Array.from(selectedTrackIds)
      : contextMenu
        ? [contextMenu.track.trackId]
        : [];
  }, [selectedTrackIds, contextMenu]);

  const handleAddToPlaylist = useCallback(
    async (playlistId: number) => {
      const ids = ctxIds();
      if (ids.length === 0) return;
      try {
        await playlistsApi.addTracksToPlaylist(playlistId, ids);
        pushRecentPlaylist(playlistId);
        onTracksChanged();
      } catch (err) {
        alert(`Failed to add: ${err}`);
      }
      setContextMenu(null);
    },
    [ctxIds, pushRecentPlaylist, onTracksChanged],
  );

  const handleAddSelectionToCrate = useCallback(() => {
    const ids = ctxIds();
    const set = new Set(ids);
    tracks.filter((t) => set.has(t.trackId)).forEach((t) => addToCrate(t));
    setContextMenu(null);
  }, [ctxIds, tracks, addToCrate]);

  const handleRemoveFromPlaylist = useCallback(
    async (track: Track) => {
      if (viewMode !== "playlist" || selectedPlaylistId === null) return;
      try {
        await playlistsApi.removeTrackFromPlaylist(selectedPlaylistId, track.trackId);
        onTracksChanged();
      } catch (err) {
        alert(`Failed to remove: ${err}`);
      }
      setContextMenu(null);
    },
    [viewMode, selectedPlaylistId, onTracksChanged],
  );

  const handleSetRating = useCallback(
    async (track: Track, stars: number) => {
      const newRating = stars * 20;
      try {
        await libraryApi.setTrackRating(track.trackId, newRating);
        onTracksChanged();
      } catch (err) {
        console.error("Failed to set rating:", err);
      }
    },
    [onTracksChanged],
  );

  // コンテキストメニュー用: 選択中（または右クリック対象）の全曲へレーティングを適用
  const handleSetRatingForSelection = useCallback(
    async (stars: number) => {
      const ids = ctxIds();
      if (ids.length === 0) return;
      const newRating = stars * 20;
      try {
        for (const id of ids) await libraryApi.setTrackRating(id, newRating);
        onTracksChanged();
      } catch (err) {
        console.error("Failed to set rating:", err);
      }
    },
    [ctxIds, onTracksChanged],
  );

  const handleEnqueue = useCallback(async () => {
    for (const id of ctxIds()) await playbackApi.enqueueTrack(id);
    setContextMenu(null);
  }, [ctxIds]);

  // 選択（or 右クリック対象）の曲を BPM/Key/Energy 解析キューへ投入（手動なので再解析強制）。
  const handleAnalyzeSelection = useCallback(async () => {
    const ids = ctxIds();
    if (ids.length > 0) {
      try {
        await analysisApi.analyzeTracks(ids, true);
      } catch (err) {
        console.error("Failed to queue analysis:", err);
      }
    }
    setContextMenu(null);
  }, [ctxIds]);

  const handleApplyAddTag = useCallback(async () => {
    const tag = newTag.trim();
    if (!tag) {
      setShowAddTagDialog(false);
      return;
    }
    try {
      await libraryApi.addGenreTag(ctxIds(), tag);
      onTracksChanged();
    } catch (err) {
      alert(`Failed: ${err}`);
    }
    setShowAddTagDialog(false);
    setNewTag("");
    setContextMenu(null);
  }, [newTag, ctxIds, onTracksChanged]);

  const handleRemoveGenreTag = useCallback(
    async (tag: string) => {
      try {
        await libraryApi.removeGenreTag(ctxIds(), tag);
        onTracksChanged();
      } catch (err) {
        alert(`Failed: ${err}`);
      }
      setContextMenu(null);
    },
    [ctxIds, onTracksChanged],
  );

  const handleGetInfo = useCallback(() => {
    if (!contextMenu) return;
    const ids = new Set(ctxIds());
    const sel = tracks.filter((t) => ids.has(t.trackId));
    onEditTrack(sel.length > 0 ? sel : [contextMenu.track]);
    setContextMenu(null);
  }, [contextMenu, ctxIds, tracks, onEditTrack]);

  // === 一覧からのジャンル直接編集 ===
  const loadGenreSuggestions = useCallback(() => {
    libraryApi
      .getAllGenreTags()
      .then((tags) => setGenreSuggestions(tags.map((t) => t.tag)))
      .catch(() => {});
  }, []);

  const openGenreEdit = useCallback(
    (e: React.MouseEvent, track: Track) => {
      e.stopPropagation();
      loadGenreSuggestions();
      setGenreEdit({
        trackId: track.trackId,
        x: e.clientX,
        y: e.clientY,
        tags: (track.genre || "").split(/\s+/).filter(Boolean),
      });
    },
    [loadGenreSuggestions],
  );

  const saveGenreEdit = useCallback(async () => {
    if (!genreEdit) return;
    const next = genreEdit.tags.join(" ");
    setGenreEdit(null);
    try {
      await libraryApi.updateTrack(genreEdit.trackId, { genre: next });
      onTracksChanged();
    } catch (err) {
      alert(`ジャンルの保存に失敗: ${err}`);
    }
  }, [genreEdit, onTracksChanged]);

  // 右クリックした 1 曲を基準に右レールの Similar タブを開く。
  const handleFindSimilar = useCallback(() => {
    if (!contextMenu) return;
    setSimilarBase(contextMenu.track.trackId);
    setContextMenu(null);
  }, [contextMenu, setSimilarBase]);

  // 選択（or 右クリック対象）の曲を変換ダイアログへ。
  const handleConvert = useCallback(() => {
    const ids = ctxIds();
    if (ids.length > 0) onConvert(ids);
    setContextMenu(null);
  }, [ctxIds, onConvert]);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  // アプリケーションキー / Shift+F10 でコンテキストメニューを開く（D）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMenuKey = e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
      if (!isMenuKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (selectedTrackIds.size === 0) return;
      const sel = tracks.find((t) => selectedTrackIds.has(t.trackId));
      if (!sel) return;
      e.preventDefault();
      const rowEl = parentRef.current?.querySelector(
        `[data-track-id="${sel.trackId}"]`,
      ) as HTMLElement | null;
      let x = 220;
      let y = 200;
      if (rowEl) {
        const r = rowEl.getBoundingClientRect();
        x = r.left + 96;
        y = r.bottom;
      }
      setContextMenu({ x, y, track: sel });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tracks, selectedTrackIds]);

  // 矢印キーでの選択移動 / 範囲拡張 と Ctrl・Cmd+A の全選択。
  // 最新状態は useStore.getState() から読むので effect は一度だけ張る。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      // モーダルが開いているときは矢印操作を奪わない。
      if (document.querySelector(".modal-overlay")) return;

      const cmd = e.ctrlKey || e.metaKey;
      const st = useStore.getState();
      const ts = st.tracks;
      if (ts.length === 0) return;

      // Ctrl/Cmd+A: 全選択。
      if (cmd && e.key.toLowerCase() === "a") {
        e.preventDefault();
        st.setSelectedTrackIds(new Set(ts.map((t) => t.trackId)));
        anchorIdRef.current = ts[0].trackId;
        focusIdRef.current = ts[ts.length - 1].trackId;
        return;
      }

      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (cmd) return; // Cmd/Ctrl+Arrow は別操作に譲る。
      e.preventDefault();

      const dir = e.key === "ArrowDown" ? 1 : -1;
      // 現在のカーソル位置を決める（フォーカス → アンカー の順でフォールバック）。
      let curIdx = ts.findIndex((t) => t.trackId === focusIdRef.current);
      if (curIdx === -1) curIdx = ts.findIndex((t) => t.trackId === anchorIdRef.current);
      const nextIdx =
        curIdx === -1
          ? dir === 1
            ? 0
            : ts.length - 1
          : Math.max(0, Math.min(ts.length - 1, curIdx + dir));
      const nextId = ts[nextIdx].trackId;

      if (e.shiftKey) {
        // アンカーから nextIdx までを範囲選択。アンカーは固定。
        if (anchorIdRef.current === null) {
          anchorIdRef.current = curIdx === -1 ? nextId : ts[curIdx].trackId;
        }
        let aIdx = ts.findIndex((t) => t.trackId === anchorIdRef.current);
        if (aIdx === -1) aIdx = nextIdx;
        const [from, to] = aIdx <= nextIdx ? [aIdx, nextIdx] : [nextIdx, aIdx];
        const next = new Set<number>();
        for (let i = from; i <= to; i++) next.add(ts[i].trackId);
        st.setSelectedTrackIds(next);
        focusIdRef.current = nextId;
      } else {
        // 単一選択を 1 行移動。アンカーも一緒に移す。
        st.setSelectedTrackIds(new Set([nextId]));
        anchorIdRef.current = nextId;
        focusIdRef.current = nextId;
      }
      virtualizerRef.current.scrollToIndex(nextIdx, { align: "auto" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const items = rowVirtualizer.getVirtualItems();
  // 右クリック対象の最新状態（レーティング更新後も即反映させるため tracks から引き直す）
  const ctxTrack = contextMenu
    ? tracks.find((t) => t.trackId === contextMenu.track.trackId) ?? contextMenu.track
    : null;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxTrack?.genre
    ? ctxTrack.genre.split(/\s+/).filter(Boolean)
    : [];
  const ctxHeaderLabel =
    selectedTrackIds.size > 1
      ? `${selectedTrackIds.size} tracks selected`
      : ctxTrack?.name || "(unknown)";

  const renderField = (id: FieldKey, t: Track): React.ReactNode => {
    switch (id) {
      case "bpm":
        return t.bpm != null ? (
          <span className="cb-fmono" style={{ color: bpmColor(t.bpm), fontWeight: 650 }}>
            {t.bpm}
          </span>
        ) : null;
      case "album":
        return <span className="cb-v ell">{t.album || ""}</span>;
      case "albumArtist":
        return <span className="cb-v ell">{t.albumArtist || ""}</span>;
      case "genre":
        return (
          <span className="cb-tags">
            {(t.genre || "")
              .split(/\s+/)
              .filter(Boolean)
              .map((g) => (
                <span
                  key={g}
                  className="cb-tag"
                  title={`Add "${g}" to filters`}
                  onClick={(e) => {
                    e.stopPropagation();
                    addFilterTag(g);
                  }}
                >
                  {g}
                </span>
              ))}
            <button
              className="cb-tag-edit"
              title="ジャンルを編集"
              onClick={(e) => openGenreEdit(e, t)}
            >
              <Icon name="edit" size={11} />
            </button>
          </span>
        );
      case "rating":
        return (
          <Stars
            value={ratingToStars(t.rating)}
            size={12}
            onSet={(n) => handleSetRating(t, n)}
          />
        );
      case "year":
        return <span className="cb-fmono cb-dim">{t.year ?? ""}</span>;
      case "plays":
        return <span className="cb-fmono cb-dim">{t.playCount ?? ""}</span>;
      case "time":
        return <span className="cb-fmono cb-dim">{formatTime(t.totalTimeMs)}</span>;
      case "trackNumber":
        return <span className="cb-fmono cb-dim">{t.trackNumber ?? ""}</span>;
      case "dateAdded":
        return <span className="cb-fmono cb-dim">{(t.dateAdded ?? "").slice(0, 10)}</span>;
      case "lastPlayed":
        return <span className="cb-fmono cb-dim">{(t.lastPlayed ?? "").slice(0, 10)}</span>;
      case "key": {
        const a = analysisByTrack.get(t.trackId);
        return a?.keyCamelot ? (
          <span
            className="cb-fmono"
            style={{ color: "var(--ac)", fontWeight: 600 }}
            title={a.keyName ?? undefined}
          >
            {a.keyCamelot}
          </span>
        ) : null;
      }
      case "energy": {
        const a = analysisByTrack.get(t.trackId);
        if (a?.energy == null) return null;
        const pct = Math.round(a.energy * 100);
        return (
          <span
            title={`Energy ${pct}`}
            style={{
              display: "inline-block",
              width: 52,
              height: 6,
              borderRadius: 3,
              background: "rgba(255,255,255,0.10)",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: `${pct}%`,
                background: "var(--ac)",
              }}
            />
          </span>
        );
      }
    }
  };

  return (
    <div className="cb-list" ref={parentRef} onScroll={handleScroll} onClick={closeMenu}>
      {/* Column header */}
      <div className="cb-head">
        <span
          className={"cb-h-id sortable" + (sortField === "name" ? " sorted" : "")}
          onClick={(e) => {
            e.stopPropagation();
            toggleSort("name");
          }}
        >
          Track
          {sortField === "name" && (
            <Icon
              name="chevronD"
              size={11}
              style={{ transform: sortOrder === "asc" ? "rotate(180deg)" : undefined }}
            />
          )}
        </span>
        {fields.map((id) => {
          const def = FIELD_DEFS[id];
          const isSorted = def.sortField !== null && def.sortField === sortField;
          return (
            <span
              key={id}
              className={"cb-h-f" + (isSorted ? " sorted" : "")}
              style={{ width: def.width }}
              onClick={(e) => {
                e.stopPropagation();
                if (def.sortField) toggleSort(def.sortField);
              }}
            >
              {def.label}
              {isSorted && (
                <Icon
                  name="chevronD"
                  size={11}
                  style={{ transform: sortOrder === "asc" ? "rotate(180deg)" : undefined }}
                />
              )}
            </span>
          );
        })}
        <span className="cb-h-add" />
      </div>

      {/* Rows */}
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
        {items.map((virtualRow) => {
          const t = tracks[virtualRow.index];
          const isCurrent = playback.currentTrackId === t.trackId;
          const isSelected = selectedTrackIds.has(t.trackId);
          const isIn = inCrate.has(t.trackId);
          return (
            <div
              key={t.id}
              data-track-id={t.trackId}
              className={
                "cb-row" +
                (isCurrent ? " play" : "") +
                (isSelected ? " selected" : "") +
                (isIn ? " incrate" : "") +
                (!t.fileExists ? " missing" : "")
              }
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onClick={(e) => handleRowClick(e, t)}
              onDoubleClick={() => handleDoubleClick(t)}
              onContextMenu={(e) => handleContextMenu(e, t)}
            >
              <div className="cb-id">
                {coverSize > 0 && (
                  <Cover
                    className="cb-cov"
                    seed={t.album}
                    glyph={t.name}
                    path={t.fileExists ? t.locationPath : null}
                    size={coverSize}
                    radius={6}
                  />
                )}
                <div className="cb-nm">
                  <div className="t" style={{ fontSize: nameFontSize }}>
                    {isCurrent && (
                      <span className="cb-now-dot">
                        <Icon name="play" size={9} fill="currentColor" stroke={0} />
                      </span>
                    )}
                    {!t.fileExists && (
                      <span className="cb-warn" title="File not found">
                        <Icon name="warning" size={12} />
                      </span>
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t.name || "(unknown)"}
                    </span>
                  </div>
                  {showArtist && <div className="a">{t.artist || ""}</div>}
                </div>
              </div>
              {fields.map((id) => (
                <span key={id} className="cb-f" style={{ width: FIELD_DEFS[id].width }}>
                  {renderField(id, t)}
                </span>
              ))}
              <span className="cb-add-cell">
                {isIn ? (
                  <span className="cb-incheck" title="In crate">
                    <Icon name="check" size={18} />
                  </span>
                ) : (
                  <button
                    className="cb-add"
                    title="Add to crate"
                    onClick={(e) => {
                      e.stopPropagation();
                      addToCrate(t);
                    }}
                  >
                    <Icon name="plus" size={17} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {isLoading && <div className="cb-loading">Loading…</div>}
      {tracks.length === 0 && !isLoading && (
        <div className="cb-empty">
          No tracks. Import an iTunes Library XML, rip a CD, or add files to get started.
        </div>
      )}

      {/* Context menu */}
      {contextMenu && ctxTrack && (
        <TrackContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          headerLabel={ctxHeaderLabel}
          ratingStars={ratingToStars(ctxTrack.rating)}
          genreTags={ctxGenreTags}
          playlists={playlists}
          recentPlaylists={recentPlaylists}
          showRemoveFromPlaylist={viewMode === "playlist"}
          onClose={closeMenu}
          onPlay={() => handleDoubleClick(ctxTrack)}
          onSetRating={handleSetRatingForSelection}
          onAddToCrate={handleAddSelectionToCrate}
          onEnqueue={handleEnqueue}
          onAnalyze={handleAnalyzeSelection}
          onFindSimilar={handleFindSimilar}
          onConvert={handleConvert}
          onGetInfo={handleGetInfo}
          onRemoveFromPlaylist={() => handleRemoveFromPlaylist(ctxTrack)}
          onAddToPlaylist={handleAddToPlaylist}
          onAddTag={() => setShowAddTagDialog(true)}
          onRemoveTag={handleRemoveGenreTag}
        />
      )}

      {/* Add genre tag dialog */}
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

      {/* 一覧からのジャンル編集ポップオーバー（外側クリックで保存） */}
      {genreEdit && (
        <div className="genre-pop-overlay" onMouseDown={saveGenreEdit}>
          <div
            className="genre-pop"
            style={{
              left: Math.min(genreEdit.x, window.innerWidth - 300),
              top: Math.min(genreEdit.y, window.innerHeight - 180),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="genre-pop-head">
              <Icon name="tag" size={13} /> ジャンルを編集
            </div>
            <GenreTagInput
              autoFocus
              value={genreEdit.tags}
              suggestions={genreSuggestions}
              placeholder="タグを入力して Enter / 候補から選択"
              onChange={(tags) => setGenreEdit((g) => (g ? { ...g, tags } : g))}
            />
            <div className="genre-pop-foot">
              <button className="toolbar-btn" onMouseDown={(e) => { e.stopPropagation(); setGenreEdit(null); }}>
                キャンセル
              </button>
              <button className="toolbar-btn primary" onMouseDown={(e) => { e.stopPropagation(); saveGenreEdit(); }}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
