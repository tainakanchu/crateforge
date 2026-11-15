import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon } from "./Icon";
import { ratingToStars, starsToRating } from "../lib/rating";
import { Cover } from "./Cover";
import { TrackContextMenu } from "./TrackContextMenu";
import { DeleteTracksDialog } from "./DeleteTracksDialog";
import { GenreTagInput } from "./GenreTagInput";
import { setTrackIdsData } from "../lib/trackDrag";
import { FIELD_DEFS } from "../types";
import type { ConvertMode, Track, Playlist } from "../types";
import { EmptyState } from "./EmptyState";
import { joinGenre, splitGenre } from "../lib/genre";
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import { AddGenreTagDialog } from "./AddGenreTagDialog";
import { useTrackActionRunner } from "../hooks/useTrackActionRunner";
import { useTrackList } from "../hooks/useTrackList";
import { useTrackSelection } from "../hooks/useTrackSelection";
import { usePlaylistReorder } from "../hooks/usePlaylistReorder";
import { useTrackListKeys } from "../hooks/useTrackListKeys";
import { useTrackColumns } from "../hooks/useTrackColumns";
import { TrackFieldCell } from "./TrackFieldCell";
import { selectionTooLargeMessage } from "../lib/selectionLimit";
import { LoadRetry } from "./LoadRetry";



interface TrackTableProps {
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[], mode?: ConvertMode) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  track: Track;
  /// 一覧の何行目か (メニューの「再生」でここから再生する)。
  index: number;
}

interface GenreEditState {
  trackId: number;
  x: number;
  y: number;
  tags: string[];
}

/// 曲の一覧。スクロール範囲は最初から全件ぶん確保し、見えている範囲の行だけを取得する
/// (docs/library-list/design.md)。このコンポーネントは描画と、行・メニューの操作の配線を持つ。
/// 選択とカーソルは useTrackSelection、プレイリストの並べ替えは usePlaylistReorder、
/// キーボードは useTrackListKeys。
export function TrackTable({ onTracksChanged, onEditTrack, onConvert }: TrackTableProps) {
  const {
    playback,
    selectedTrackIds,
    toggleTrackSelection,
    setSelectedTrackIds,
    playlists,
    viewMode,
    selectedPlaylistId,
    searchQuery,
    filterTags,
    addFilterTag,
    fields,
    fieldWidths,
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
    keyNotation,
    setSimilarBase,
    nameColWidth,
  } = useStore();
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);
  const run = useTrackActionRunner();

  const list = useTrackList();
  const parentRef = useRef<HTMLDivElement>(null);
  // 行の仮想化 (下で作る) を、先に作る hook から参照するための ref。
  const scrollToIndexRef = useRef<(index: number) => void>(() => {});
  const scrollToIndex = useCallback((index: number) => scrollToIndexRef.current(index), []);
  const rowHRef = useRef(rowH);
  rowHRef.current = rowH;
  const visibleRows = useCallback(
    () => Math.floor((parentRef.current?.clientHeight ?? 0) / rowHRef.current),
    [],
  );
  const selection = useTrackSelection({ list, run, scrollToIndex, visibleRows });

  const columns = useTrackColumns();
  const { rowMinWidth } = columns;

  // === 行のドラッグ (プレイリスト内の並べ替え / 外部へのドロップ) ===
  // 手動順 (playlistOrder) で通常プレイリストを開いていて、検索で絞っていない
  // ときだけ行の並べ替えを許可する。それ以外は「ドラッグして他所へ渡す」のみ。
  const activePlaylist =
    viewMode === "playlist" && selectedPlaylistId !== null
      ? playlists.find((p) => p.playlistId === selectedPlaylistId)
      : undefined;
  const manualReorder =
    !!activePlaylist &&
    !activePlaylist.isSmart &&
    !activePlaylist.isFolder &&
    sortField === "playlistOrder" &&
    !searchQuery.trim() &&
    filterTags.length === 0;

  const reorder = usePlaylistReorder({
    list,
    enabled: manualReorder,
    playlistId: selectedPlaylistId,
    onWritten: onTracksChanged,
    scrollToIndex,
  });

  const handleRowDragStart = useCallback(
    (e: React.DragEvent, track: Track, index: number) => {
      // 未選択の行を掴んだらその行だけを対象にする (選択もそこへ移す)。
      // 選択中の行なら、選択中の曲を表示順で運ぶ。
      let ids: number[];
      if (selectedTrackIds.has(track.trackId)) {
        ids = selection.orderedSelection();
      } else {
        ids = [track.trackId];
        selection.setCursor(index, track.trackId);
        setSelectedTrackIds(new Set(ids));
      }
      setTrackIdsData(e.dataTransfer, ids);
      // サイドバー/Crate へは追加 (copy)、プレイリスト内では並べ替え (move)。
      e.dataTransfer.effectAllowed = "copyMove";
      reorder.beginDrag(ids);
    },
    [selection, reorder, selectedTrackIds, setSelectedTrackIds],
  );

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // ジャンルタグ追加ダイアログの対象曲 (null で非表示)。対象はダイアログを開いた時点で決める
  // (入力中に選択が変わっても、開いたときの曲に付く)。TracksView / AlbumsView と同じ。
  const [addTagTargetIds, setAddTagTargetIds] = useState<number[] | null>(null);
  // 削除確認モーダルの対象曲の ID（null で非表示）。window.confirm は使わない。
  const [deleteTargets, setDeleteTargets] = useState<number[] | null>(null);
  const [newTag, setNewTag] = useState("");
  // 一覧からのジャンル直接編集（ポップオーバー）。
  const [genreEdit, setGenreEdit] = useState<GenreEditState | null>(null);
  const [genreSuggestions, setGenreSuggestions] = useState<string[]>([]);

  const inCrate = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);
  // 行が高いときは曲名の下にアーティストを出す (Artist 列を表示中なら重複するので出さない)。
  const showArtist = rowH >= 50 && !fields.includes("artist");
  const nameFontSize = rowH < 44 ? 13 : 14.5;

  const rowVirtualizer = useVirtualizer({
    count: list.count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 16,
  });
  scrollToIndexRef.current = (index) => rowVirtualizer.scrollToIndex(index, { align: "auto" });

  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowH]);

  // 描画する行 (overscan を含む) の範囲を伝える。足りないページの取得はここから始まる。
  const virtualItems = rowVirtualizer.getVirtualItems();
  const firstRow = virtualItems.length > 0 ? virtualItems[0].index : -1;
  const lastRow = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (firstRow >= 0) list.setVisibleRange(firstRow, lastRow);
  }, [list.setVisibleRange, firstRow, lastRow]);

  // 一覧が切り替わったら (スコープ・検索・並び順の変更) 先頭へ戻す。
  useEffect(() => {
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }, [list.key]);

  const handleRowClick = useCallback(
    (e: React.MouseEvent, track: Track, index: number) => {
      selection.clickRow({ shift: e.shiftKey, additive: e.ctrlKey || e.metaKey }, track, index);
    },
    [selection],
  );

  /// 一覧の全曲 (読み込んでいない行も含む) を表示順でキューに入れ、index の行から再生する。
  const handleDoubleClick = useCallback(
    async (track: Track, index: number) => {
      if (!track.fileExists) return;
      await run(
        "play",
        async () => {
          const ids = await list.getIds();
          // 同じ曲が複数回入るプレイリストでも、クリックした行から始める。
          const start =
            ids[index] === track.trackId ? index : Math.max(0, ids.indexOf(track.trackId));
          await trackActions.playQueueFrom(trackApi, ids, start, track.trackId);
        },
        track.name || "(unknown)",
      );
    },
    [list, run],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, track: Track, index: number) => {
      e.preventDefault();
      if (!selectedTrackIds.has(track.trackId)) {
        selection.setCursor(index, track.trackId);
        toggleTrackSelection(track.trackId, false);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, track, index });
    },
    [selection, selectedTrackIds, toggleTrackSelection],
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
      setContextMenu(null);
      if (ids.length === 0) return;
      await run("addToPlaylist", async () => {
        const added = await trackActions.addTracksToPlaylist(trackApi, playlists, playlistId, ids);
        pushRecentPlaylist(playlistId);
        onTracksChanged();
        pushToast("success", trackActions.addedToPlaylistMessage(added));
      });
    },
    [ctxIds, pushRecentPlaylist, onTracksChanged, pushToast, playlists, run],
  );

  /// trackId 列を、一覧の表示順の曲に解決する (読み込んでいない行の曲は ID で取り直す)。
  /// 曲の情報そのものを読み込むので、選択が大きすぎるときは行わない (action は文言用)。
  /// 上限超過・取得の失敗はトーストで知らせて空を返す。
  const tracksInListOrder = useCallback(
    async (ids: readonly number[], action: string): Promise<Track[]> => {
      const tooLarge = selectionTooLargeMessage(ids.length, action);
      if (tooLarge) {
        pushToast("error", tooLarge);
        return [];
      }
      let ts: Track[] = [];
      await run("loadTracks", async () => {
        ts = await list.resolveTracks(await list.orderByList(ids));
      });
      return ts;
    },
    [list, run, pushToast],
  );

  const handleAddSelectionToCrate = useCallback(async () => {
    const ids = ctxIds();
    setContextMenu(null);
    for (const t of await tracksInListOrder(ids, " Crate に追加")) addToCrate(t);
  }, [ctxIds, tracksInListOrder, addToCrate]);

  // 選択（or 右クリック対象）の曲をまとめて今のプレイリストから外す。
  // 同じ曲が複数回入っている場合は、単曲版と同じく各曲の最初の 1 つだけを外す。
  const handleRemoveFromPlaylist = useCallback(async () => {
    const ids = ctxIds();
    setContextMenu(null);
    if (viewMode !== "playlist" || selectedPlaylistId === null || ids.length === 0) return;
    await run("removeFromPlaylist", async () => {
      const removed = await playlistsApi.removeTracksFromPlaylist(selectedPlaylistId, ids);
      // 外した曲は一覧から消えるので、選択も残さない（見えない曲が選択件数に残らないように）。
      setSelectedTrackIds(new Set());
      onTracksChanged();
      if (removed > 1) pushToast("success", `${removed} 曲をプレイリストから外しました`);
    });
  }, [ctxIds, viewMode, selectedPlaylistId, setSelectedTrackIds, onTracksChanged, pushToast, run]);

  const handleSetRating = useCallback(
    async (track: Track, stars: number) => {
      const newRating = starsToRating(stars);
      await run("rating", async () => {
        try {
          await trackActions.setRatingForTracks(trackApi, [track.trackId], newRating);
        } finally {
          // 失敗しても取り直して、一覧を実際の値に合わせる。
          onTracksChanged();
        }
      });
    },
    [onTracksChanged, run],
  );

  // コンテキストメニュー用: 選択中（または右クリック対象）の全曲へレーティングを適用
  const handleSetRatingForSelection = useCallback(
    async (stars: number) => {
      const ids = ctxIds();
      if (ids.length === 0) return;
      const newRating = starsToRating(stars);
      const menu = contextMenu;
      const ok = await run("rating", async () => {
        try {
          await trackActions.setRatingForTracks(trackApi, ids, newRating);
        } finally {
          // 失敗しても取り直して、一覧を実際の値に合わせる (複数曲は 1 トランザクションで変わる)。
          onTracksChanged();
        }
      });
      // 星はメニューを開いたまま付け直せるが、失敗したら (プレビューの星が残らないよう) 閉じる。
      // 待っている間に別のメニューが開かれていたら、そちらは閉じない。
      if (!ok) setContextMenu((cur) => (cur === menu ? null : cur));
    },
    [ctxIds, contextMenu, onTracksChanged, run],
  );

  const handleEnqueue = useCallback(async () => {
    const ids = ctxIds();
    setContextMenu(null);
    await run("enqueue", () => trackActions.enqueueTracks(trackApi, ids));
  }, [ctxIds, run]);

  // 「次に再生」: 現在曲の直後に選択順で並ぶ (挿入順の反転は playNextTracks 側)。
  const handlePlayNext = useCallback(async () => {
    const ids = ctxIds();
    setContextMenu(null);
    await run("playNext", () => trackActions.playNextTracks(trackApi, ids));
  }, [ctxIds, run]);

  // 選択（or 右クリック対象）の曲を BPM/Key/Energy 解析キューへ投入（手動なので再解析強制）。
  const handleAnalyzeSelection = useCallback(async () => {
    const ids = ctxIds();
    setContextMenu(null);
    if (ids.length > 0) await run("analyze", () => analysisApi.analyzeTracks(ids, true));
  }, [ctxIds, run]);

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

  const handleRemoveGenreTag = useCallback(
    async (tag: string) => {
      const ids = ctxIds();
      setContextMenu(null);
      await run("removeTag", async () => {
        const result = await libraryApi.removeGenreTag(ids, tag);
        onTracksChanged();
        const warning = trackActions.genreFileWriteFailureMessage(result);
        if (warning) pushToast("error", warning);
      });
    },
    [ctxIds, onTracksChanged, run, pushToast],
  );

  const handleGetInfo = useCallback(async () => {
    if (!contextMenu) return;
    const fallback = contextMenu.track;
    const ids = ctxIds();
    setContextMenu(null);
    // 右クリックした 1 曲だけなら、手元の曲をそのまま開く。
    if (ids.length <= 1) {
      onEditTrack([fallback]);
      return;
    }
    const sel = await tracksInListOrder(ids, "編集");
    if (sel.length > 0) onEditTrack(sel);
  }, [contextMenu, ctxIds, tracksInListOrder, onEditTrack]);

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
        tags: splitGenre(track.genre),
      });
    },
    [loadGenreSuggestions],
  );

  const saveGenreEdit = useCallback(async () => {
    if (!genreEdit) return;
    const next = joinGenre(genreEdit.tags);
    setGenreEdit(null);
    await run("saveGenre", async () => {
      await libraryApi.updateTrack(genreEdit.trackId, { genre: next });
      onTracksChanged();
    });
  }, [genreEdit, onTracksChanged, run]);

  // 右クリックした 1 曲を基準に右レールの Similar タブを開く。
  const handleFindSimilar = useCallback(() => {
    if (!contextMenu) return;
    setSimilarBase(contextMenu.track.trackId, { focus: true });
    setContextMenu(null);
  }, [contextMenu, setSimilarBase]);

  // 選択（or 右クリック対象）の曲を変換ダイアログへ。
  const handleConvert = useCallback(() => {
    const ids = ctxIds();
    if (ids.length > 0) onConvert(ids);
    setContextMenu(null);
  }, [ctxIds, onConvert]);

  const handleConvertReplace = useCallback(() => {
    const ids = ctxIds();
    if (ids.length > 0) onConvert(ids, "replace");
    setContextMenu(null);
  }, [ctxIds, onConvert]);

  // 選択（or 右クリック対象）の曲を削除確認モーダルへ渡す。確認は ID だけで出せる
  // (件数・先頭の数曲・ルート外の数はバックエンドが数える) ので、何曲でも読み込まない。
  const handleDelete = useCallback(() => {
    const ids = ctxIds();
    setContextMenu(null);
    if (ids.length > 0) setDeleteTargets(ids);
  }, [ctxIds]);

  // 右クリックした 1 曲を Finder / エクスプローラで表示する。
  const handleReveal = useCallback(async (path: string) => {
    setContextMenu(null);
    await run("reveal", () => libraryApi.revealInFileManager(path));
  }, [run]);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  // アプリケーションキー / Shift+F10: フォーカス行 (無ければ読み込み済みの最初の選択行) の位置に
  // コンテキストメニューを開く。
  const openMenuAtCursor = useCallback(() => {
    const focus = selection.focusRef.current;
    let index = focus ? selection.rowIndexOf(focus) : -1;
    let sel = index >= 0 ? list.get(index) : undefined;
    if (!sel || !selectedTrackIds.has(sel.trackId)) {
      sel = undefined;
      for (const [i, t] of list.loaded()) {
        if (selectedTrackIds.has(t.trackId)) {
          sel = t;
          index = i;
          break;
        }
      }
    }
    const open = (track: Track, at: number) => {
      const rowEl = parentRef.current?.querySelector(
        `[data-track-id="${track.trackId}"]`,
      ) as HTMLElement | null;
      let x = 220;
      let y = 200;
      if (rowEl) {
        const r = rowEl.getBoundingClientRect();
        x = r.left + 96;
        y = r.bottom;
      }
      setContextMenu({ x, y, track, index: at });
    };
    if (sel) {
      open(sel, index);
      return;
    }
    // 選択した行がどれも読み込まれていない (離れた位置までスクロールした) ときは ID で取り直す。
    const firstId = selectedTrackIds.values().next().value;
    if (firstId === undefined) return;
    void run("loadTracks", async () => {
      const [track] = await list.resolveTracks([firstId]);
      if (track) open(track, Math.max(0, (await list.getIds()).indexOf(firstId)));
    });
  }, [list, selection, selectedTrackIds, run]);

  useTrackListKeys({
    rootRef: parentRef,
    count: list.count,
    selection,
    reorder,
    onDelete: (ids) => {
      setContextMenu(null);
      setDeleteTargets(ids);
    },
    onMenuKey: openMenuAtCursor,
  });

  // 右クリック対象の最新状態（レーティング更新後も即反映させるため、読み込み済みの行から引き直す）
  const ctxTrack = contextMenu
    ? (list.loadedTrack(contextMenu.track.trackId) ?? contextMenu.track)
    : null;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxTrack?.genre
    ? splitGenre(ctxTrack.genre)
    : [];
  const ctxHeaderLabel =
    selectedTrackIds.size > 1
      ? `${selectedTrackIds.size} 曲を選択中`
      : ctxTrack?.name || "(unknown)";

  return (
    <div className="cb-list" ref={parentRef} onClick={closeMenu}>
      {/* Column header */}
      <div className="cb-head" ref={columns.headRef} style={{ minWidth: rowMinWidth }}>
        <span
          ref={columns.nameHeadRef}
          className={"cb-h-id sortable" + (sortField === "name" ? " sorted" : "")}
          // nameColWidth が数値なら固定幅、null なら従来どおり flex:1。
          style={
            nameColWidth != null
              ? { position: "relative", flex: "0 0 auto", width: nameColWidth }
              : { position: "relative" }
          }
          onClick={(e) => {
            e.stopPropagation();
            // リサイズ直後の click はソートとして扱わない。
            if (columns.consumeSortClick()) return;
            toggleSort("name");
          }}
        >
          曲名
          {sortField === "name" && (
            <Icon
              name="chevronD"
              size={11}
              style={{ transform: sortOrder === "asc" ? "rotate(180deg)" : undefined }}
            />
          )}
          {/* 右端のリサイズハンドル。他列と同じ pointer 方式で曲名列を固定幅化する。 */}
          <span
            className="cb-h-resize"
            onPointerDown={columns.onNameResizePointerDown}
            onPointerMove={columns.onNameResizePointerMove}
            onPointerUp={columns.onNameResizePointerUp}
            onClick={(e) => e.stopPropagation()}
          />
        </span>
        {fields.map((id, index) => {
          const def = FIELD_DEFS[id];
          const isSorted = def.sortField !== null && def.sortField === sortField;
          const width = fieldWidths[id] ?? def.width;
          const isDragging = columns.draggingColumn === index;
          return (
            <span
              key={id}
              data-col-index={index}
              className={
                "cb-h-f cb-h-drag" +
                (isSorted ? " sorted" : "") +
                (isDragging ? " dragging" : "") +
                (columns.dropIndicator === index ? " dropbefore" : "")
              }
              style={{ width }}
              title="ドラッグで並べ替え / 右端でリサイズ"
              onPointerDown={(e) => columns.onHeadPointerDown(e, index)}
              onPointerMove={columns.onHeadPointerMove}
              onPointerUp={columns.onHeadPointerUp}
              onClick={(e) => {
                e.stopPropagation();
                // リサイズ / 並べ替え直後の click はソートとして扱わない。
                if (columns.consumeSortClick()) return;
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
              {/* 右端のリサイズハンドル（ヘッダドラッグとは当たり判定を分ける）。 */}
              <span
                className="cb-h-resize"
                onPointerDown={(e) => columns.onResizePointerDown(e, id)}
                onPointerMove={columns.onResizePointerMove}
                onPointerUp={columns.onResizePointerUp}
                onClick={(e) => e.stopPropagation()}
              />
            </span>
          );
        })}
        {/* 末尾へのドロップ位置インジケータ。 */}
        {columns.dropIndicator === fields.length && <span className="cb-h-droplast" />}
        {/* 末尾の add 列プレースホルダ。本体行の .cb-add-cell(40px) と列幅を揃える。
            以前ここにあった「N選択 / N曲」表示は flex 行に可変幅要素を挟み、曲名列
            (flex:1) の幅をヘッダーと本体でずらして列をミスアラインさせていたため撤去し、
            選択/件数はツールバー(cb-subbar)へ移設した。 */}
        <span className="cb-h-add" />
      </div>

      {/* Rows */}
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: "relative",
          minWidth: rowMinWidth,
        }}
      >
        {virtualItems.map((virtualRow) => {
          const t = list.get(virtualRow.index);
          const rowStyle: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: `${virtualRow.size}px`,
            transform: `translateY(${virtualRow.start}px)`,
          };
          // まだ読み込んでいない行は同じ高さのプレースホルダ (届いても位置がずれない)。
          if (!t) {
            return (
              <div
                key={`ph-${virtualRow.index}`}
                className="cb-row ph"
                style={rowStyle}
                aria-hidden
              >
                <div
                  className="cb-id"
                  style={nameColWidth != null ? { flex: "0 0 auto", width: nameColWidth } : undefined}
                >
                  <span className="cb-ph-bar" style={{ width: "45%" }} />
                </div>
              </div>
            );
          }
          const isCurrent = playback.currentTrackId === t.trackId;
          const isSelected = selectedTrackIds.has(t.trackId);
          const isIn = inCrate.has(t.trackId);
          const isDragging = reorder.draggingIds?.has(t.trackId) ?? false;
          // 挿入線: dropIndex の行の手前へ。末尾へのドロップだけ最終行の下に出す。
          const dropBefore = reorder.dropIndex === virtualRow.index;
          const dropAfter =
            reorder.dropIndex === list.count && virtualRow.index === list.count - 1;
          return (
            <div
              // 同じ曲を複数回含むプレイリストでは t.trackId が重複する。重複 key は React の
              // 差分照合を壊し、別ビューへ移った後も古い行 DOM が残って重なる (ゴースト行)。
              // 位置込みの key で一意にする (選択・並べ替えは trackId / index ベースなので影響なし)。
              key={`${t.trackId}-${virtualRow.index}`}
              data-track-id={t.trackId}
              className={
                "cb-row" +
                (isCurrent ? " play" : "") +
                (isSelected ? " selected" : "") +
                (isIn ? " incrate" : "") +
                (!t.fileExists ? " missing" : "") +
                (isDragging ? " dragging" : "") +
                (dropBefore ? " dropbefore" : "") +
                (dropAfter ? " dropafter" : "")
              }
              style={rowStyle}
              title={
                manualReorder
                  ? "ドラッグで並べ替え (Alt+↑↓ でも移動) / サイドバーのプレイリストへドロップで追加"
                  : undefined
              }
              draggable
              onDragStart={(e) => handleRowDragStart(e, t, virtualRow.index)}
              onDragEnd={reorder.endDrag}
              onDragOver={(e) => reorder.dragOver(e, virtualRow.index)}
              onDrop={reorder.drop}
              onClick={(e) => handleRowClick(e, t, virtualRow.index)}
              onDoubleClick={() => handleDoubleClick(t, virtualRow.index)}
              onContextMenu={(e) => handleContextMenu(e, t, virtualRow.index)}
            >
              <div
                className="cb-id"
                // 曲名列が固定幅なら row 側も合わせる（null は CSS の flex:1）。
                style={nameColWidth != null ? { flex: "0 0 auto", width: nameColWidth } : undefined}
              >
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
                      <span className="cb-warn" title="ファイルが見つかりません">
                        <Icon name="warning" size={12} />
                      </span>
                    )}
                    <span
                      style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                      title={t.name || "(unknown)"}
                    >
                      {t.name || "(unknown)"}
                    </span>
                  </div>
                  {showArtist && (
                    <div className="a" title={t.artist || ""}>
                      {t.artist || ""}
                    </div>
                  )}
                </div>
              </div>
              {fields.map((id) => (
                <span
                  key={id}
                  className="cb-f"
                  style={{ width: fieldWidths[id] ?? FIELD_DEFS[id].width }}
                >
                  <TrackFieldCell
                    id={id}
                    track={t}
                    rowIndex={virtualRow.index}
                    analysis={analysisByTrack.get(t.trackId)}
                    keyNotation={keyNotation}
                    onFilterTag={addFilterTag}
                    onEditGenre={openGenreEdit}
                    onSetRating={handleSetRating}
                  />
                </span>
              ))}
              <span className="cb-add-cell">
                {isIn ? (
                  <span className="cb-incheck" title="Crate に追加済み">
                    <Icon name="check" size={18} />
                  </span>
                ) : (
                  <button
                    className="cb-add"
                    title="Crate に追加"
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

      {list.loading && (
        <div
          className="cb-loading"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
        >
          {/* 簡易スピナー（keyframe はこの場で一度だけ定義）。 */}
          <style>{"@keyframes cb-spin{to{transform:rotate(360deg)}}"}</style>
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "2px solid var(--bd)",
              borderTopColor: "var(--ac)",
              animation: "cb-spin 0.7s linear infinite",
            }}
          />
          <span>読み込み中…</span>
        </div>
      )}
      {list.failed && (
        <div className="cb-list-retry">
          <LoadRetry message="一覧の一部を取得できませんでした" onRetry={list.retry} />
        </div>
      )}
      {list.count === 0 && !list.loading && (
        <EmptyState />
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
          showRemoveFromPlaylist={
            // スマート / フォルダは所属を直接持たないので「外す」は出さない。
            !!activePlaylist && !activePlaylist.isSmart && !activePlaylist.isFolder
          }
          revealPath={
            // 「表示」は単曲のみ。複数選択・ファイル欠損時は無効表示にする。
            ctxIds().length === 1 && ctxTrack.fileExists ? ctxTrack.locationPath : null
          }
          relocateTrack={
            // 「ファイルの場所を指定…」も単曲のみ (リンク切れでなくても付け替えられる)。
            ctxIds().length === 1 ? ctxTrack : null
          }
          deleteCount={ctxIds().length}
          onClose={closeMenu}
          onPlay={() => handleDoubleClick(ctxTrack, contextMenu.index)}
          onSetRating={handleSetRatingForSelection}
          onAddToCrate={handleAddSelectionToCrate}
          onPlayNext={handlePlayNext}
          onEnqueue={handleEnqueue}
          onAnalyze={handleAnalyzeSelection}
          onFindSimilar={handleFindSimilar}
          onConvert={handleConvert}
          onConvertReplace={handleConvertReplace}
          onGetInfo={handleGetInfo}
          onRemoveFromPlaylist={handleRemoveFromPlaylist}
          onReveal={() => void handleReveal(ctxTrack.locationPath ?? "")}
          onDelete={handleDelete}
          onAddToPlaylist={handleAddToPlaylist}
          onAddTag={() => {
            // 対象が無ければダイアログを開かない。
            const ids = ctxIds();
            if (ids.length > 0) setAddTagTargetIds(ids);
          }}
          onRemoveTag={handleRemoveGenreTag}
        />
      )}

      {/* Add genre tag dialog */}
      {addTagTargetIds && (
        <AddGenreTagDialog
          value={newTag}
          onChange={setNewTag}
          onSubmit={() => void handleApplyAddTag()}
          onClose={() => setAddTagTargetIds(null)}
        />
      )}

      {/* ライブラリからの削除（確認モーダル） */}
      {deleteTargets && (
        <DeleteTracksDialog
          trackIds={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onDeleted={() => {
            setSelectedTrackIds(new Set());
            onTracksChanged();
          }}
        />
      )}

      {/* 一覧からのジャンル編集ポップオーバー（外側クリックで保存） */}
      {genreEdit && (
        // mousedown ではなく click + 同一ターゲット判定で誤保存を防ぐ。
        // （down がポップ内→up が overlay 等のドラッグで誤発火しないよう、
        //  overlay 自身が click ターゲットのときだけ保存する）
        <div
          className="genre-pop-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) saveGenreEdit();
          }}
        >
          <div
            className="genre-pop"
            style={{
              left: Math.min(genreEdit.x, window.innerWidth - 300),
              top: Math.min(genreEdit.y, window.innerHeight - 180),
            }}
            onClick={(e) => e.stopPropagation()}
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
