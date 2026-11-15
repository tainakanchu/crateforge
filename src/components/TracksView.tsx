import { useCallback, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon } from "./Icon";
import { ArtworkImg } from "./Cover";
import { TrackContextMenu } from "./TrackContextMenu";
import { DeleteTracksDialog } from "./DeleteTracksDialog";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import { ratingToStars, starsToRating } from "../lib/rating";
import type { ConvertMode, Track, Playlist } from "../types";
import { EmptyState } from "./EmptyState";
import { ANALYZED_BPM_TITLE, effectiveBpm } from "../lib/bpm";
import { splitGenre } from "../lib/genre";
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
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import { AddGenreTagDialog } from "./AddGenreTagDialog";
import { useTrackActionRunner } from "../hooks/useTrackActionRunner";

interface CtxMenu {
  x: number;
  y: number;
  track: Track;
}

interface TracksViewProps {
  onLoadMore: () => void;
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[], mode?: ConvertMode) => void;
}


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
  const run = useTrackActionRunner();
  const analysisByTrack = useStore((s) => s.analysisByTrack);

  const { ref: setParentRef, elRef: parentRef, width } = useElementWidth<HTMLDivElement>();
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null);
  const [showAddTagDialog, setShowAddTagDialog] = useState(false);
  // 削除確認モーダルの対象曲（null で非表示）。
  const [deleteTargets, setDeleteTargets] = useState<Track[] | null>(null);
  const [newTag, setNewTag] = useState("");

  const { cols, cardW } = gridMetrics(width);
  const rows = useMemo(() => buildGridRows(tracks, cols), [tracks, cols]);
  const rowVirtualizer = useCardGridVirtualizer({
    rows,
    scrollRef: parentRef,
    cols,
    gridRowHeight: cardW + META_H + GAP,
  });

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !hasMore) return;
    if (isNearBottom(el)) onLoadMore();
  }, [isLoading, hasMore, onLoadMore]);

  const playTrack = useCallback(async (t: Track) => {
    const ids = trackActions.playableIds(tracks);
    if (ids.length === 0) return;
    const start = Math.max(0, ids.indexOf(t.trackId));
    // キューは再生できる曲だけ。鳴らすのはクリックした曲そのもの。
    await run(
      "play",
      () => trackActions.playQueueFrom(trackApi, ids, start, t.trackId),
      t.name || "(unknown)",
    );
  }, [tracks, run]);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const openTrackMenu = useCallback((e: React.MouseEvent, t: Track) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, track: t });
  }, []);

  const handleSetRating = useCallback(async (stars: number) => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    const ok = await run("rating", async () => {
      await trackActions.setRatingForTracks(trackApi, [id], starsToRating(stars));
      onTracksChanged();
    });
    // 星はメニューを開いたまま付け直せるが、失敗したら (プレビューの星が残らないよう) 閉じる。
    if (!ok) closeMenu();
  }, [contextMenu, onTracksChanged, run, closeMenu]);

  const handleAddToCrate = useCallback(() => {
    if (!contextMenu) return;
    addToCrate(contextMenu.track);
    closeMenu();
  }, [contextMenu, addToCrate, closeMenu]);

  const handleEnqueue = useCallback(async () => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    closeMenu();
    await run("enqueue", () => trackActions.enqueueTracks(trackApi, [id]));
  }, [contextMenu, closeMenu, run]);

  const handlePlayNext = useCallback(async () => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    closeMenu();
    await run("playNext", () => trackActions.playNextTracks(trackApi, [id]));
  }, [contextMenu, closeMenu, run]);

  const handleAnalyze = useCallback(async () => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    closeMenu();
    await run("analyze", () => analysisApi.analyzeTracks([id], true));
  }, [contextMenu, closeMenu, run]);

  const handleFindSimilar = useCallback(() => {
    if (!contextMenu) return;
    // 明示的な「Find similar」なので Similar タブへフォーカスする (#151)
    setSimilarBase(contextMenu.track.trackId, { focus: true });
    closeMenu();
  }, [contextMenu, setSimilarBase, closeMenu]);

  const handleConvert = useCallback(() => {
    if (!contextMenu) return;
    onConvert([contextMenu.track.trackId]);
    closeMenu();
  }, [contextMenu, onConvert, closeMenu]);

  const handleConvertReplace = useCallback(() => {
    if (!contextMenu) return;
    onConvert([contextMenu.track.trackId], "replace");
    closeMenu();
  }, [contextMenu, onConvert, closeMenu]);

  // Finder / エクスプローラで表示（このビューは常に単曲）。
  const handleReveal = useCallback(async () => {
    const path = contextMenu?.track.locationPath;
    if (!path) return;
    closeMenu();
    await run("reveal", () => libraryApi.revealInFileManager(path));
  }, [contextMenu, closeMenu, run]);

  const handleDelete = useCallback(() => {
    if (!contextMenu) return;
    setDeleteTargets([contextMenu.track]);
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleGetInfo = useCallback(() => {
    if (!contextMenu) return;
    onEditTrack([contextMenu.track]);
    closeMenu();
  }, [contextMenu, onEditTrack, closeMenu]);

  const handleAddToPlaylist = useCallback(async (playlistId: number) => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    closeMenu();
    await run("addToPlaylist", async () => {
      const added = await trackActions.addTracksToPlaylist(trackApi, playlists, playlistId, [id]);
      pushRecentPlaylist(playlistId);
      onTracksChanged();
      pushToast("success", trackActions.addedToPlaylistMessage(added));
    });
  }, [contextMenu, pushRecentPlaylist, onTracksChanged, closeMenu, pushToast, playlists, run]);

  const handleRemoveFromPlaylist = useCallback(async () => {
    if (!contextMenu || viewMode !== "playlist" || selectedPlaylistId === null) return;
    const id = contextMenu.track.trackId;
    closeMenu();
    await run("removeFromPlaylist", async () => {
      await playlistsApi.removeTrackFromPlaylist(selectedPlaylistId, id);
      onTracksChanged();
    });
  }, [contextMenu, viewMode, selectedPlaylistId, onTracksChanged, closeMenu, run]);

  const handleApplyAddTag = useCallback(async () => {
    const tag = newTag.trim();
    if (!tag || !contextMenu) {
      setShowAddTagDialog(false);
      return;
    }
    const id = contextMenu.track.trackId;
    setShowAddTagDialog(false);
    setNewTag("");
    closeMenu();
    await run("addTag", async () => {
      await libraryApi.addGenreTag([id], tag);
      onTracksChanged();
    });
  }, [newTag, contextMenu, onTracksChanged, closeMenu, run]);

  const handleRemoveTag = useCallback(async (tag: string) => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    closeMenu();
    await run("removeTag", async () => {
      await libraryApi.removeGenreTag([id], tag);
      onTracksChanged();
    });
  }, [contextMenu, onTracksChanged, closeMenu, run]);

  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  const ctxTrack = contextMenu
    ? tracks.find((t) => t.trackId === contextMenu.track.trackId) ?? contextMenu.track
    : null;
  const activePlaylist =
    viewMode === "playlist" && selectedPlaylistId !== null
      ? playlists.find((p) => p.playlistId === selectedPlaylistId)
      : undefined;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxTrack?.genre ? splitGenre(ctxTrack.genre) : [];

  if (tracks.length === 0 && !isLoading) {
    return (
      <div className="cb-grid-wrap">
        <EmptyState />
      </div>
    );
  }

  const items = rowVirtualizer.getVirtualItems();

  return (
    <div className="cb-grid-wrap" ref={setParentRef} onScroll={handleScroll} onClick={closeMenu}>
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
                {row.items.map((t, j) => {
                  const inCrate = crateSet.has(t.trackId);
                  const isCurrent = playback.currentTrackId === t.trackId;
                  return (
                    // プレイリストに同じ曲が複数あると t.id が重複するため位置込みの key にする。
                    <div key={`${t.id}-${j}`} className="cb-cardwrap">
                      <div
                        className={"cb-card" + (inCrate ? " incrate" : "") + (isCurrent ? " playing" : "")}
                        style={{ background: artGradient(t.album || t.name || ""), height: cardW }}
                        onDoubleClick={() => void playTrack(t)}
                        onContextMenu={(e) => openTrackMenu(e, t)}
                      >
                        <span className="glyph">{leadingGlyph(t.album || t.name || "")}</span>
                        <ArtworkImg path={t.fileExists ? t.locationPath : null} size={cardW} />
                        <span className="grad" />
                        {(() => {
                          // 実効 BPM (タグ ?? 解析値)。解析値は薄く表示する。
                          const b = effectiveBpm(t, analysisByTrack.get(t.trackId));
                          return b ? (
                            <div
                              className="kbtag"
                              title={b.fromAnalysis ? ANALYZED_BPM_TITLE : undefined}
                            >
                              <span
                                style={{
                                  color: bpmColor(b.value),
                                  opacity: b.fromAnalysis ? 0.6 : undefined,
                                }}
                              >
                                {b.value}
                              </span>
                            </div>
                          ) : null;
                        })()}
                        <button
                          className="cov-play"
                          title="再生"
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
                            title="Crate に追加済み"
                          >
                            <Icon name="check" size={17} />
                          </span>
                        ) : (
                          <button
                            className="addbtn"
                            title="Crate に追加"
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
                        title={[t.name || "(unknown)", t.artist].filter(Boolean).join(" — ")}
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
          ratingStars={ratingToStars(ctxTrack.rating)}
          genreTags={ctxGenreTags}
          playlists={playlists}
          recentPlaylists={recentPlaylists}
          showRemoveFromPlaylist={
            // スマート / フォルダは所属を直接持たないので「外す」は出さない。
            !!activePlaylist && !activePlaylist.isSmart && !activePlaylist.isFolder
          }
          revealPath={ctxTrack.fileExists ? ctxTrack.locationPath : null}
          relocateTrack={ctxTrack}
          deleteCount={1}
          onClose={closeMenu}
          onPlay={() => { void playTrack(contextMenu.track); closeMenu(); }}
          onSetRating={handleSetRating}
          onAddToCrate={handleAddToCrate}
          onPlayNext={handlePlayNext}
          onEnqueue={handleEnqueue}
          onAnalyze={handleAnalyze}
          onFindSimilar={handleFindSimilar}
          onConvert={handleConvert}
          onConvertReplace={handleConvertReplace}
          onGetInfo={handleGetInfo}
          onRemoveFromPlaylist={handleRemoveFromPlaylist}
          onReveal={() => void handleReveal()}
          onDelete={handleDelete}
          onAddToPlaylist={handleAddToPlaylist}
          onAddTag={() => setShowAddTagDialog(true)}
          onRemoveTag={handleRemoveTag}
        />
      )}

      {deleteTargets && (
        <DeleteTracksDialog
          tracks={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onDeleted={onTracksChanged}
        />
      )}

      {showAddTagDialog && (
        <AddGenreTagDialog
          value={newTag}
          onChange={setNewTag}
          onSubmit={() => void handleApplyAddTag()}
          onClose={() => setShowAddTagDialog(false)}
        />
      )}
    </div>
  );
}
