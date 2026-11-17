import { useCallback, useEffect, useMemo, useState } from "react";
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
  gridLayout,
  gridMetrics,
} from "../lib/gridRows";
import { useElementWidth } from "../hooks/useElementWidth";
import { useCardGridVirtualizer } from "../hooks/useCardGridVirtualizer";
import { useTrackList } from "../hooks/useTrackList";
import { PlaceholderCard } from "./PlaceholderCard";
import { LoadRetry } from "./LoadRetry";
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import { AddGenreTagDialog } from "./AddGenreTagDialog";
import { useTrackActionRunner } from "../hooks/useTrackActionRunner";

interface CtxMenu {
  x: number;
  y: number;
  track: Track;
  /** 一覧の何曲目か (メニューの「再生」でここから再生する)。 */
  index: number;
}

interface TracksViewProps {
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[], mode?: ConvertMode) => void;
}


/// 1 曲 1 枚のカード表示。スクロール範囲は最初から全件ぶん確保し、見えている範囲の曲だけを
/// 取得する (docs/library-list/design.md)。
export function TracksView({ onTracksChanged, onEditTrack, onConvert }: TracksViewProps) {
  const {
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
  // ジャンルタグ追加ダイアログの対象曲 (null で非表示)。メニューは項目を選んだ時点で閉じて
  // contextMenu が null になるので、対象は開くときにここへ控えておく。
  const [addTagTargetIds, setAddTagTargetIds] = useState<number[] | null>(null);
  // 削除確認モーダルの対象曲（null で非表示）。
  const [deleteTargets, setDeleteTargets] = useState<number[] | null>(null);
  const [newTag, setNewTag] = useState("");

  const { cols, cardW } = gridMetrics(width);
  const list = useTrackList();
  const layout = useMemo(() => gridLayout(list.count, cols), [list.count, cols]);
  const rowVirtualizer = useCardGridVirtualizer({
    layout,
    scrollRef: parentRef,
    gridRowHeight: cardW + META_H + GAP,
    onVisibleItems: list.setVisibleRange,
  });

  // 一覧が切り替わったら (スコープ・検索・並び順の変更) 先頭へ戻す。
  useEffect(() => {
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }, [list.key, parentRef]);

  // index はカードの通し番号 (一覧の何曲目か)。キューには一覧の全曲を表示順で入れ、
  // クリックした曲から再生する (読み込んでいない曲も含む。TrackTable と同じ)。
  const playTrack = useCallback(
    async (t: Track, index: number) => {
      await run(
        "play",
        async () => {
          const ids = await list.getIds();
          const start = ids[index] === t.trackId ? index : Math.max(0, ids.indexOf(t.trackId));
          await trackActions.playQueueFrom(trackApi, ids, start, t.trackId);
        },
        t.name || "(unknown)",
      );
    },
    [list, run],
  );

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const openTrackMenu = useCallback((e: React.MouseEvent, t: Track, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, track: t, index });
  }, []);

  const handleSetRating = useCallback(async (stars: number) => {
    if (!contextMenu) return;
    const menu = contextMenu;
    const ok = await run("rating", async () => {
      try {
        await trackActions.setRatingForTracks(trackApi, [menu.track.trackId], starsToRating(stars));
      } finally {
        // 失敗しても取り直して、一覧を実際の値に合わせる。
        onTracksChanged();
      }
    });
    // 星はメニューを開いたまま付け直せるが、失敗したら (プレビューの星が残らないよう) 閉じる。
    // 待っている間に別のメニューが開かれていたら、そちらは閉じない。
    if (!ok) setContextMenu((cur) => (cur === menu ? null : cur));
  }, [contextMenu, onTracksChanged, run]);

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
    setDeleteTargets([contextMenu.track.trackId]);
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
    const ids = addTagTargetIds;
    setAddTagTargetIds(null);
    if (!tag || !ids || ids.length === 0) return;
    setNewTag("");
    await run("addTag", async () => {
      const result = await libraryApi.addGenreTag(ids, tag);
      onTracksChanged();
      const warning = trackActions.genreFileWriteFailureMessage(result);
      if (warning) pushToast("error", warning);
    });
  }, [newTag, addTagTargetIds, onTracksChanged, run, pushToast]);

  const handleRemoveTag = useCallback(async (tag: string) => {
    if (!contextMenu) return;
    const id = contextMenu.track.trackId;
    closeMenu();
    await run("removeTag", async () => {
      const result = await libraryApi.removeGenreTag([id], tag);
      onTracksChanged();
      const warning = trackActions.genreFileWriteFailureMessage(result);
      if (warning) pushToast("error", warning);
    });
  }, [contextMenu, onTracksChanged, closeMenu, run, pushToast]);

  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  // メニュー表示用 (レーティングは最新の行から引き直す)。
  const ctxTrack = contextMenu
    ? (list.loadedTrack(contextMenu.track.trackId) ?? contextMenu.track)
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

  if (list.count === 0 && !list.loading) {
    return (
      <div className="cb-grid-wrap">
        <EmptyState />
      </div>
    );
  }

  const items = rowVirtualizer.getVirtualItems();

  return (
    <div className="cb-grid-wrap" ref={setParentRef} onClick={closeMenu}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
        {items.map((vRow) => {
          const row = layout.rowAt(vRow.index);
          if (row.type !== "grid") return null;
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
                {Array.from({ length: row.end - row.start }, (_, j) => {
                  const index = row.start + j;
                  const t = list.get(index);
                  // 未取得の曲は同じ高さのプレースホルダ (届いても行がずれない)。
                  if (!t) return <PlaceholderCard key={`ph:${index}`} size={cardW} />;
                  const inCrate = crateSet.has(t.trackId);
                  const isCurrent = playback.currentTrackId === t.trackId;
                  return (
                    // プレイリストに同じ曲が複数あると t.trackId が重複するため位置込みの key にする。
                    <div key={`${t.trackId}-${j}`} className="cb-cardwrap">
                      <div
                        className={"cb-card" + (inCrate ? " incrate" : "") + (isCurrent ? " playing" : "")}
                        style={{ background: artGradient(t.album || t.name || ""), height: cardW }}
                        onDoubleClick={() => void playTrack(t, index)}
                        onContextMenu={(e) => openTrackMenu(e, t, index)}
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
                            void playTrack(t, index);
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
                        onDoubleClick={() => void playTrack(t, index)}
                        onContextMenu={(e) => openTrackMenu(e, t, index)}
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
      {list.loading && <div className="cb-loading">Loading…</div>}
      {list.failed && (
        <div className="cb-list-retry">
          <LoadRetry message="一覧の一部を取得できませんでした" onRetry={list.retry} />
        </div>
      )}

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
          onPlay={() => { void playTrack(contextMenu.track, contextMenu.index); closeMenu(); }}
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
          onAddTag={() => setAddTagTargetIds([contextMenu.track.trackId])}
          onRemoveTag={handleRemoveTag}
        />
      )}

      {deleteTargets && (
        <DeleteTracksDialog
          trackIds={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onDeleted={onTracksChanged}
        />
      )}

      {addTagTargetIds && (
        <AddGenreTagDialog
          value={newTag}
          onChange={setNewTag}
          onSubmit={() => void handleApplyAddTag()}
          onClose={() => setAddTagTargetIds(null)}
        />
      )}
    </div>
  );
}
