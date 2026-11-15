import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon, Stars } from "./Icon";
import { ratingToStars, starsToRating } from "../lib/rating";
import { Cover } from "./Cover";
import { TrackContextMenu } from "./TrackContextMenu";
import { DeleteTracksDialog } from "./DeleteTracksDialog";
import { GenreTagInput } from "./GenreTagInput";
import { bpmColor } from "../lib/art";
import { ANALYZED_BPM_TITLE, effectiveBpm } from "../lib/bpm";
import { formatChannels, formatFileSize, formatSampleRate } from "../lib/techMeta";
import {
  anchorsForDrop,
  moveIdsWithin,
  setTrackIdsData,
} from "../lib/trackDrag";
import { FIELD_DEFS } from "../types";
import type { ConvertMode, Track, FieldKey, Playlist } from "../types";
import { describeKey, effectiveKeyCamelot, formatKey, isKeyOverridden } from "../lib/keyNotation";
import { EmptyState } from "./EmptyState";
import { joinGenre, splitGenre } from "../lib/genre";
import { formatTrackTime } from "../lib/format";
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import { AddGenreTagDialog } from "./AddGenreTagDialog";
import { useTrackActionRunner } from "../hooks/useTrackActionRunner";
import { useTrackList } from "../hooks/useTrackList";
import { clampRange, isCursorKey, moveCursor } from "../lib/windowedList";
import type { CursorKey } from "../lib/windowedList";

// 曲名列の最小幅 (未固定 = flex のとき)。styles.css の .cb-id / .cb-h-id と揃える。
const NAME_MIN_WIDTH = 180;
// .cb-row / .cb-head の左右パディングと、末尾の追加ボタン列 (.cb-add-cell) の幅。
const ROW_SIDE_PADDING = 18;
const ADD_CELL_WIDTH = 40;


interface TrackTableProps {
  onTracksChanged: () => void;
  /// プレイリスト内の並べ替えを書き込んだあと。一覧を取り直し、動かした曲の選択を残す。
  onReordered: (trackIds: number[]) => void;
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

/// 行の参照 (範囲選択の起点・カーソル)。行番号と、その行の曲で覚える。一覧を取り直して行が
/// ずれたら曲から行を探し直す。id が null なのは、まだ読み込んでいない行へカーソルを動かした直後。
interface RowRef {
  index: number;
  id: number | null;
}

interface GenreEditState {
  trackId: number;
  x: number;
  y: number;
  tags: string[];
}

/// 曲の一覧。スクロール範囲は最初から全件ぶん確保し、見えている範囲の行だけを取得する
/// (docs/library-list/design.md)。選択は trackId の集合、起点とカーソルは行番号で持つので、
/// 読み込んでいない行をまたぐ操作 (範囲選択・全選択・ここから再生) も同じ結果になる。
export function TrackTable({ onTracksChanged, onReordered, onEditTrack, onConvert }: TrackTableProps) {
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
    setFieldWidth,
    reorderFields,
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
    setNameColWidth,
  } = useStore();
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);
  const run = useTrackActionRunner();

  const list = useTrackList();
  // 一度だけ張る keydown effect と非同期処理から、最新の一覧を参照するための ref。
  const listRef = useRef(list);
  listRef.current = list;

  const parentRef = useRef<HTMLDivElement>(null);
  // 範囲選択の起点（Shift の基準）と、矢印移動のカーソル位置。
  const anchorRef = useRef<RowRef | null>(null);
  const focusRef = useRef<RowRef | null>(null);

  /// 行の参照を、いまの一覧での行番号に直す。
  const rowIndexOf = useCallback((ref: RowRef): number => {
    const l = listRef.current;
    const fallback = Math.max(0, Math.min(ref.index, l.count - 1));
    if (ref.id === null || l.get(ref.index)?.trackId === ref.id) return fallback;
    return l.loadedIndexOf(ref.id) ?? fallback;
  }, []);

  /// 行番号 a〜b (順不同・両端を含む) の trackId。読み込んでいない行があれば全曲の ID 列から切り出す。
  const idsInRange = useCallback(async (a: number, b: number): Promise<number[]> => {
    const l = listRef.current;
    const range = clampRange(a, b, l.count);
    if (!range) return [];
    const out: number[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const t = l.get(i);
      if (!t) return (await l.getIds()).slice(range.start, range.end + 1);
      out.push(t.trackId);
    }
    return out;
  }, []);

  // === 列ヘッダの pointer 操作（リサイズ / 並べ替え） ===
  // ヘッダ各列の DOM 参照。ドラッグ中の当たり判定（挿入位置算出）に使う。
  const headRef = useRef<HTMLDivElement>(null);
  // リサイズ中の状態（ハンドル pointerdown 時にセット）。
  const resizeRef = useRef<{ key: FieldKey; startX: number; startW: number } | null>(null);
  // 列並べ替えのドラッグ状態（ヘッダ本体 pointerdown 時にセット）。
  const colDragRef = useRef<{ from: number; startX: number; pointerId: number; moved: boolean } | null>(null);
  // 並べ替え中のドロップ先インジケータ（fields 配列の挿入位置 0..fields.length）。null で非表示。
  const [dropIndicator, setDropIndicator] = useState<number | null>(null);
  // ドラッグ操作（リサイズ / 並べ替え）の直後に発火するヘッダ click をソートとして
  // 誤発火させないためのフラグ。pointerup 直後の click を 1 回だけ握りつぶす。
  const suppressNextSortClick = useRef(false);

  const clampWidth = (w: number) => Math.max(40, Math.min(600, w));

  // --- 列リサイズ（ハンドル）---
  const onResizePointerDown = (e: React.PointerEvent, id: FieldKey) => {
    // ヘッダ本体のドラッグ（並べ替え）/ ソートへ伝播させない。
    e.stopPropagation();
    e.preventDefault();
    const startW = fieldWidths[id] ?? FIELD_DEFS[id].width;
    resizeRef.current = { key: id, startX: e.clientX, startW };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    e.preventDefault();
    setFieldWidth(r.key, clampWidth(r.startW + (e.clientX - r.startX)));
  };
  const onResizePointerUp = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    e.stopPropagation();
    resizeRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    // 直後のヘッダ click（ソート）を抑止する。
    suppressNextSortClick.current = true;
  };

  // --- Track（曲名）列のリサイズ ---
  // nameColWidth が null（flex:1）のときはドラッグ開始時の実描画幅を初期値に固定幅化する。
  const nameResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  // 曲名列の最小幅。カバー/曲名が潰れないよう他列より広めにクランプ。
  const clampNameWidth = (w: number) => Math.max(160, Math.min(900, w));
  // 行の最小幅 = 左右パディング + 曲名列 (未固定なら最小 NAME_MIN_WIDTH) + 各列 + 追加ボタン列。
  // 一覧の幅がこれを下回ったら曲名列を潰さずに横スクロールさせる (列を増やしたとき / 最小ウィンドウ)。
  const rowMinWidth =
    ROW_SIDE_PADDING * 2 +
    (nameColWidth ?? NAME_MIN_WIDTH) +
    fields.reduce((sum, id) => sum + (fieldWidths[id] ?? FIELD_DEFS[id].width), 0) +
    ADD_CELL_WIDTH;
  const nameHeadRef = useRef<HTMLSpanElement>(null);
  const onNameResizePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // 現在の実描画幅を初期値に（固定済みなら nameColWidth、未固定なら DOM 実測）。
    const startW = nameColWidth ?? nameHeadRef.current?.getBoundingClientRect().width ?? 260;
    nameResizeRef.current = { startX: e.clientX, startW };
    setNameColWidth(clampNameWidth(startW));
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };
  const onNameResizePointerMove = (e: React.PointerEvent) => {
    const r = nameResizeRef.current;
    if (!r) return;
    e.preventDefault();
    setNameColWidth(clampNameWidth(r.startW + (e.clientX - r.startX)));
  };
  const onNameResizePointerUp = (e: React.PointerEvent) => {
    if (!nameResizeRef.current) return;
    e.stopPropagation();
    nameResizeRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    suppressNextSortClick.current = true;
  };

  // --- 列並べ替え（ヘッダ本体ドラッグ）---
  // pointerdown 時点の位置と列インデックスを記録し、一定距離動いたらドラッグ開始。
  // 動かなければ通常クリック（ソート）として扱う。
  const COL_DRAG_THRESHOLD = 5;
  const onHeadPointerDown = (e: React.PointerEvent, index: number) => {
    // リサイズハンドルからの down は onResizePointerDown が stopPropagation するのでここには来ない。
    if (e.button !== 0) return;
    colDragRef.current = { from: index, startX: e.clientX, pointerId: e.pointerId, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  // pointer X からドロップ先の挿入インデックス（0..fields.length）を算出する。
  const computeDropIndex = (clientX: number): number => {
    const head = headRef.current;
    if (!head) return 0;
    const cells = Array.from(
      head.querySelectorAll<HTMLElement>("[data-col-index]"),
    );
    for (const cell of cells) {
      const r = cell.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if (clientX < mid) {
        return Number(cell.dataset.colIndex);
      }
    }
    return cells.length;
  };
  const onHeadPointerMove = (e: React.PointerEvent) => {
    const d = colDragRef.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < COL_DRAG_THRESHOLD) return;
      d.moved = true;
      document.body.style.userSelect = "none";
    }
    setDropIndicator(computeDropIndex(e.clientX));
  };
  const onHeadPointerUp = (e: React.PointerEvent) => {
    const d = colDragRef.current;
    colDragRef.current = null;
    if (!d) return;
    document.body.style.userSelect = "";
    if (d.moved) {
      // 挿入位置 → reorderFields の to に変換。
      // 配列から from を抜くと、from より後ろの挿入位置は 1 つ前へずれる。
      let to = computeDropIndex(e.clientX);
      if (to > d.from) to -= 1;
      to = Math.max(0, Math.min(fields.length - 1, to));
      if (to !== d.from) reorderFields(d.from, to);
      // ドラッグ直後の click（ソート）を抑止。
      suppressNextSortClick.current = true;
    }
    setDropIndicator(null);
  };
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

  // ドラッグ中の状態は ref で持ち、再描画は「挿入線の位置が変わったとき」だけに絞る。
  const dragIdsRef = useRef<number[] | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingIds, setDraggingIds] = useState<Set<number> | null>(null);
  // 並べ替えの書き込みを直列化する (連続操作で全曲取得と書き込みが交錯しないように)。
  const reorderChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWritesRef = useRef(0);
  // 取り直しが要る (連続操作のどれかが並びを書き換えた)。
  const reorderDirtyRef = useRef(false);
  const clearRowDrag = useCallback(() => {
    dragIdsRef.current = null;
    dropIndexRef.current = null;
    setDropIndex(null);
    setDraggingIds(null);
  }, []);

  /**
   * プレイリストの曲 movingIds を、全曲順の挿入位置 (0..曲数) へ 1 ブロックとして移動する。
   *
   * 挿入位置は、書き込みの直前に取り直した全曲順 (DB の sort_index 順) を受けて決める
   * (dropAtOf。動かせなければ null)。手動順の一覧は検索・並べ替えなしなので、表示中の行番号が
   * そのまま全曲順の位置になる。連続操作でも、前の書き込みを反映した順から動かせる。
   * 書き込みが片付いたら一覧を取り直す (動かした曲の選択は残す)。
   */
  const commitReorder = useCallback(
    (movingIds: number[], dropAtOf: (all: number[]) => number | null, scrollToBlock = false) => {
      const playlistId = useStore.getState().selectedPlaylistId;
      if (playlistId === null || movingIds.length === 0) return;

      pendingWritesRef.current += 1;
      const settle = () => {
        pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
        // 追い越し操作が残っているうちは再読み込みしない (途中経過で画面が跳ねる)。
        if (pendingWritesRef.current > 0 || !reorderDirtyRef.current) return;
        reorderDirtyRef.current = false;
        onReordered(movingIds);
      };
      reorderChainRef.current = reorderChainRef.current
        .then(async () => {
          // reorder_playlist_tracks は渡した ID 列で全置換するので、必ず全曲順から組み立てる。
          const all = await playlistsApi.getPlaylistTrackIds(playlistId);
          const dropAt = dropAtOf(all);
          if (dropAt === null) return;
          const { before, after } = anchorsForDrop(all, movingIds, dropAt);
          const next = moveIdsWithin(all, movingIds, before, after);
          if (next.every((id, i) => id === all[i])) return;
          // 書き込みが途中で失敗しても、実際の並びに合わせ直す。
          reorderDirtyRef.current = true;
          await playlistsApi.reorderPlaylistTracks(playlistId, next);
          if (scrollToBlock) {
            const idx = next.findIndex((id) => movingIds.includes(id));
            if (idx >= 0) virtualizerRef.current.scrollToIndex(idx, { align: "auto" });
          }
        })
        .then(settle)
        .catch((err) => {
          useStore
            .getState()
            .pushToast("error", `並べ替えに失敗しました: ${err}`);
          settle();
        });
    },
    [onReordered],
  );

  // 空 deps の keydown effect から最新の値を参照するための ref。
  const manualReorderRef = useRef(manualReorder);
  manualReorderRef.current = manualReorder;
  const commitReorderRef = useRef(commitReorder);
  commitReorderRef.current = commitReorder;

  // 選択が複数あるときは、ドラッグ開始 (同期処理) で表示順に並べられるよう ID 列を先に取っておく。
  const multiSelected = selectedTrackIds.size > 1;
  useEffect(() => {
    if (multiSelected) void list.getIds().catch(() => {});
  }, [multiSelected, list.getIds, list.key]);

  const handleRowDragStart = useCallback(
    (e: React.DragEvent, track: Track, index: number) => {
      // 未選択の行を掴んだらその行だけを対象にする (選択もそこへ移す)。
      let ids: number[];
      if (selectedTrackIds.has(track.trackId)) {
        // 選択中の曲を表示順で渡す。ID 列が未取得なら、読み込み済みの行の順 → 残りの選択の順。
        const seen = new Set<number>();
        ids = [];
        const take = (id: number) => {
          if (!selectedTrackIds.has(id) || seen.has(id)) return;
          seen.add(id);
          ids.push(id);
        };
        const all = list.peekIds();
        if (all) all.forEach(take);
        else for (const [, t] of list.loaded()) take(t.trackId);
        selectedTrackIds.forEach(take);
      } else {
        ids = [track.trackId];
        anchorRef.current = { index, id: track.trackId };
        focusRef.current = { index, id: track.trackId };
        setSelectedTrackIds(new Set(ids));
      }
      dragIdsRef.current = ids;
      setTrackIdsData(e.dataTransfer, ids);
      // サイドバー/Crate へは追加 (copy)、プレイリスト内では並べ替え (move)。
      e.dataTransfer.effectAllowed = "copyMove";
      setDraggingIds(new Set(ids));
    },
    [list, selectedTrackIds, setSelectedTrackIds],
  );

  const handleRowDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      // 自前の行ドラッグのみ受ける (ファイル取り込み等は DropImportOverlay に任せる)。
      if (!manualReorder || !dragIdsRef.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const at = e.clientY < r.top + r.height / 2 ? index : index + 1;
      if (dropIndexRef.current !== at) {
        dropIndexRef.current = at;
        setDropIndex(at);
      }
    },
    [manualReorder],
  );

  const handleRowDrop = useCallback(
    (e: React.DragEvent) => {
      if (!manualReorder) return;
      const ids = dragIdsRef.current;
      const at = dropIndexRef.current;
      clearRowDrag();
      if (!ids || at === null) return;
      e.preventDefault();
      e.stopPropagation();
      commitReorder(ids, () => at);
    },
    [manualReorder, clearRowDrag, commitReorder],
  );

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // ジャンルタグ追加ダイアログの対象曲 (null で非表示)。対象はダイアログを開いた時点で決める
  // (入力中に選択が変わっても、開いたときの曲に付く)。TracksView / AlbumsView と同じ。
  const [addTagTargetIds, setAddTagTargetIds] = useState<number[] | null>(null);
  // 削除確認モーダルの対象曲（null で非表示）。window.confirm は使わない。
  const [deleteTargets, setDeleteTargets] = useState<Track[] | null>(null);
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
  // キーボード操作（空 deps の effect）から最新の virtualizer を参照するための ref。
  const virtualizerRef = useRef(rowVirtualizer);
  virtualizerRef.current = rowVirtualizer;
  const rowHRef = useRef(rowH);
  rowHRef.current = rowH;

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

  // 一覧が切り替わったら (スコープ・検索・並び順の変更) 先頭へ戻し、起点とカーソルを捨てる。
  useEffect(() => {
    anchorRef.current = null;
    focusRef.current = null;
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }, [list.key]);

  /// 行番号 a〜b を選択する (base に足す)。待っているあいだに一覧が切り替わったら何もしない。
  const selectRange = useCallback(
    async (a: number, b: number, base: ReadonlySet<number>) => {
      const key = listRef.current.key;
      await run("loadTracks", async () => {
        const ids = await idsInRange(a, b);
        if (listRef.current.key !== key) return;
        const next = new Set(base);
        for (const id of ids) next.add(id);
        setSelectedTrackIds(next);
      });
    },
    [idsInRange, run, setSelectedTrackIds],
  );

  const handleRowClick = useCallback(
    (e: React.MouseEvent, track: Track, index: number) => {
      const additive = e.ctrlKey || e.metaKey;
      const here: RowRef = { index, id: track.trackId };
      if (e.shiftKey) {
        // アンカー（前回クリック位置）から今回までを範囲選択。アンカーは
        // 動かさないので、Shift クリックを繰り返すと同じ起点から伸縮できる。
        // 読み込んでいない行をまたいでも、行番号の範囲で選ぶ。
        const anchor = anchorRef.current ?? here;
        anchorRef.current = anchor;
        focusRef.current = here;
        // Shift+Ctrl/Cmd は既存選択へ追加、ただの Shift は置き換え。
        void selectRange(rowIndexOf(anchor), index, additive ? selectedTrackIds : new Set());
        return;
      }
      // 通常クリック / Ctrl・Cmd クリック: アンカーとフォーカスをここへ移す。
      anchorRef.current = here;
      focusRef.current = here;
      toggleTrackSelection(track.trackId, additive);
    },
    [selectedTrackIds, selectRange, rowIndexOf, toggleTrackSelection],
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
        anchorRef.current = { index, id: track.trackId };
        focusRef.current = { index, id: track.trackId };
        toggleTrackSelection(track.trackId, false);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, track, index });
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
  /// 失敗はトーストで知らせて空を返す。
  const tracksInListOrder = useCallback(
    async (ids: readonly number[]): Promise<Track[]> => {
      let ts: Track[] = [];
      await run("loadTracks", async () => {
        ts = await list.resolveTracks(await list.orderByList(ids));
      });
      return ts;
    },
    [list, run],
  );

  const handleAddSelectionToCrate = useCallback(async () => {
    const ids = ctxIds();
    setContextMenu(null);
    for (const t of await tracksInListOrder(ids)) addToCrate(t);
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
          // 複数曲の途中で失敗しても、先に成功した曲の値が一覧に出るよう取り直す。
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
    const sel = await tracksInListOrder(ids);
    onEditTrack(sel.length > 0 ? sel : [fallback]);
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

  // 選択（or 右クリック対象）の曲を削除確認モーダルへ渡す。
  const openDeleteDialog = useCallback(
    async (ids: readonly number[]) => {
      const sel = await tracksInListOrder(ids);
      if (sel.length > 0) setDeleteTargets(sel);
    },
    [tracksInListOrder],
  );

  const handleDelete = useCallback(() => {
    const ids = ctxIds();
    setContextMenu(null);
    void openDeleteDialog(ids);
  }, [ctxIds, openDeleteDialog]);

  // 右クリックした 1 曲を Finder / エクスプローラで表示する。
  const handleReveal = useCallback(async (path: string) => {
    setContextMenu(null);
    await run("reveal", () => libraryApi.revealInFileManager(path));
  }, [run]);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  // Delete (macOS は Cmd+Backspace も) で選択中の曲の削除確認ダイアログを開く。
  // 入力欄にフォーカスがあるとき・モーダル表示中は何もしない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isDeleteKey = e.key === "Delete" || (e.metaKey && e.key === "Backspace");
      if (!isDeleteKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (document.querySelector(".modal-overlay")) return;
      if (selectedTrackIds.size === 0) return;
      e.preventDefault();
      setContextMenu(null);
      void openDeleteDialog(Array.from(selectedTrackIds));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTrackIds, openDeleteDialog]);

  // アプリケーションキー / Shift+F10 でコンテキストメニューを開く（D）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMenuKey = e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
      if (!isMenuKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (selectedTrackIds.size === 0) return;
      e.preventDefault();
      // フォーカス行を優先し、無ければ読み込み済みの最初の選択行を基準にする。
      const focus = focusRef.current;
      let index = focus ? rowIndexOf(focus) : -1;
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
      const firstId = selectedTrackIds.values().next().value as number;
      void run("loadTracks", async () => {
        const [track] = await list.resolveTracks([firstId]);
        if (track) open(track, Math.max(0, (await list.getIds()).indexOf(firstId)));
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selectedTrackIds, rowIndexOf, run]);

  /// フォーカス行 (無ければ選択の先頭) から、一覧の全曲をキューに入れて再生する (Enter)。
  const playFromCursor = useCallback(async () => {
    const l = listRef.current;
    await run("play", async () => {
      const ids = await l.getIds();
      const focus = focusRef.current;
      let index = -1;
      if (focus) {
        const i = rowIndexOf(focus);
        index = focus.id === null || ids[i] === focus.id ? i : ids.indexOf(focus.id);
      }
      if (index < 0) {
        const selected = useStore.getState().selectedTrackIds;
        index = ids.findIndex((id) => selected.has(id));
      }
      if (index < 0 || index >= ids.length) return;
      const track = await l.ensure(index);
      if (!track || !track.fileExists) return;
      await trackActions.playQueueFrom(trackApi, ids, index, ids[index]);
    });
  }, [rowIndexOf, run]);

  // カーソル移動は連続して届く (キーの押しっぱなし)。古い移動の結果で選択を上書きしない。
  const cursorSeqRef = useRef(0);
  /// カーソルを動かす (↑ ↓ PageUp PageDown Home End)。extend なら起点からの範囲選択。
  /// 行番号だけで動かすので、読み込んでいない行へも行ける (曲の ID は必要になってから取る)。
  const moveCursorBy = useCallback(
    (key: CursorKey, extend: boolean) => {
      const l = listRef.current;
      const cursor = focusRef.current ?? anchorRef.current;
      const cur = cursor ? rowIndexOf(cursor) : null;
      const visibleRows = Math.floor((parentRef.current?.clientHeight ?? 0) / rowHRef.current);
      const next = moveCursor(key, cur, l.count, visibleRows - 1);
      if (next === null) return;
      virtualizerRef.current.scrollToIndex(next, { align: "auto" });

      const seq = ++cursorSeqRef.current;
      const listKey = l.key;
      const isCurrent = () => seq === cursorSeqRef.current && listRef.current.key === listKey;
      // 行番号は先に確定させる (ID を待つあいだに次のキーが来ても、続きから動ける)。
      const target: RowRef = { index: next, id: l.get(next)?.trackId ?? null };
      focusRef.current = target;
      if (extend) {
        // アンカーは固定。無ければ移動前のカーソル (それも無ければ移動先) を起点にする。
        anchorRef.current ??= cursor ?? target;
        void selectRangeRef.current(rowIndexOf(anchorRef.current), next, isCurrent);
      } else {
        // 単一選択を移動。アンカーも一緒に移す。
        anchorRef.current = target;
        void run("loadTracks", async () => {
          const id = target.id ?? (await l.getIds())[next];
          if (!isCurrent() || id === undefined) return;
          target.id = id;
          useStore.getState().setSelectedTrackIds(new Set([id]));
        });
      }
    },
    [rowIndexOf, run],
  );
  /// 行番号 a〜b だけを選択する (カーソル移動用。古い移動の結果は捨てる)。
  const selectRangeRef = useRef(async (_a: number, _b: number, _isCurrent: () => boolean) => {});
  selectRangeRef.current = async (a, b, isCurrent) => {
    await run("loadTracks", async () => {
      const ids = await idsInRange(a, b);
      if (isCurrent()) setSelectedTrackIds(new Set(ids));
    });
  };

  // 最新の値を一度だけ張る keydown effect から参照するための ref。
  const playFromCursorRef = useRef(playFromCursor);
  playFromCursorRef.current = playFromCursor;
  const moveCursorByRef = useRef(moveCursorBy);
  moveCursorByRef.current = moveCursorBy;
  const runRef = useRef(run);
  runRef.current = run;

  // カーソル移動 (↑ ↓ PageUp PageDown Home End) / 範囲拡張 と Ctrl・Cmd+A の全選択、Enter の再生。
  // 最新状態は ref と useStore.getState() から読むので effect は一度だけ張る。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      // モーダルが開いているときは矢印操作を奪わない。
      if (document.querySelector(".modal-overlay")) return;

      const cmd = e.ctrlKey || e.metaKey;
      const st = useStore.getState();
      const l = listRef.current;
      if (l.count === 0) return;

      // Ctrl/Cmd+A: 全選択 (読み込んでいない行も含む一覧の全曲)。
      if (cmd && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const listKey = l.key;
        void runRef.current("loadTracks", async () => {
          const ids = await l.getIds();
          if (listRef.current.key !== listKey || ids.length === 0) return;
          st.setSelectedTrackIds(new Set(ids));
          anchorRef.current = { index: 0, id: ids[0] };
          focusRef.current = { index: ids.length - 1, id: ids[ids.length - 1] };
        });
        return;
      }

      // Enter: フォーカス行（無ければ選択先頭）の曲を再生。
      if (e.key === "Enter" && !cmd) {
        if (!focusRef.current && st.selectedTrackIds.size === 0) return;
        e.preventDefault();
        void playFromCursorRef.current();
        return;
      }

      if (!isCursorKey(e.key)) return;
      if (cmd) return; // Cmd/Ctrl+Arrow は別操作に譲る。
      const isArrow = e.key === "ArrowDown" || e.key === "ArrowUp";
      if (e.altKey && !isArrow) return;

      // Alt+↑/↓: プレイリストの手動順のとき、選択行を 1 つ上/下へ動かす
      // (ドラッグ並べ替えのキーボード版)。手動順でなければ通常の選択移動に落とす。
      if (e.altKey && manualReorderRef.current) {
        const sel = st.selectedTrackIds;
        if (sel.size === 0) return;
        e.preventDefault();
        const movingIds = Array.from(sel);
        const up = e.key === "ArrowUp";
        commitReorderRef.current(
          movingIds,
          (all) => {
            const idxs: number[] = [];
            all.forEach((id, i) => {
              if (sel.has(id)) idxs.push(i);
            });
            if (idxs.length === 0) return null;
            if (up) {
              // 選択ブロックの直前にある非選択行の位置へ差し込む。
              let i = idxs[0] - 1;
              while (i >= 0 && sel.has(all[i])) i--;
              return i < 0 ? null : i; // null: すでに先頭
            }
            let i = idxs[idxs.length - 1] + 1;
            while (i < all.length && sel.has(all[i])) i++;
            return i >= all.length ? null : i + 1; // null: すでに末尾
          },
          true,
        );
        return;
      }
      e.preventDefault();
      moveCursorByRef.current(e.key, e.shiftKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const renderField = (id: FieldKey, t: Track, rowIndex: number): React.ReactNode => {
    switch (id) {
      case "rowIndex":
        // 現在の表示順での連番 (1 始まり)。アルバムの trackNumber とは別物。
        return <span className="cb-fmono cb-dim">{rowIndex + 1}</span>;
      case "bpm": {
        // 実効 BPM (タグ ?? 解析値)。解析値は薄く表示してツールチップで区別する。
        const b = effectiveBpm(t, analysisByTrack.get(t.trackId));
        return b ? (
          <span
            className="cb-fmono"
            style={{
              color: bpmColor(b.value),
              fontWeight: 650,
              opacity: b.fromAnalysis ? 0.6 : undefined,
            }}
            title={b.fromAnalysis ? ANALYZED_BPM_TITLE : undefined}
          >
            {b.value}
          </span>
        ) : null;
      }
      case "artist":
        return <span className="cb-v ell" title={t.artist || ""}>{t.artist || ""}</span>;
      case "album":
        return <span className="cb-v ell" title={t.album || ""}>{t.album || ""}</span>;
      case "albumArtist":
        return <span className="cb-v ell" title={t.albumArtist || ""}>{t.albumArtist || ""}</span>;
      case "genre":
        return (
          <span className="cb-tags">
            {splitGenre(t.genre).map((g) => (
                <span
                  key={g}
                  className="cb-tag"
                  title={`「${g}」で絞り込む`}
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
        return <span className="cb-fmono cb-dim">{formatTrackTime(t.totalTimeMs)}</span>;
      case "trackNumber":
        return <span className="cb-fmono cb-dim">{t.trackNumber ?? ""}</span>;
      case "dateAdded":
        return <span className="cb-fmono cb-dim">{(t.dateAdded ?? "").slice(0, 10)}</span>;
      case "lastPlayed":
        return <span className="cb-fmono cb-dim">{(t.lastPlayed ?? "").slice(0, 10)}</span>;
      // 技術メタデータ (#171)。未取得 (null) は空欄。
      case "codec":
        return <span className="cb-fmono cb-dim">{t.codec ?? ""}</span>;
      case "bitrate":
        return (
          <span className="cb-fmono cb-dim">{t.bitrateKbps != null ? `${t.bitrateKbps} kbps` : ""}</span>
        );
      case "sampleRate":
        return <span className="cb-fmono cb-dim">{formatSampleRate(t.sampleRateHz)}</span>;
      case "bitDepth":
        return <span className="cb-fmono cb-dim">{t.bitDepth != null ? `${t.bitDepth}-bit` : ""}</span>;
      case "channels":
        return <span className="cb-fmono cb-dim">{formatChannels(t.channels)}</span>;
      case "fileSize":
        return <span className="cb-fmono cb-dim">{formatFileSize(t.fileSizeBytes)}</span>;
      case "key": {
        // 実効キー (手動上書き ?? 解析値) を設定の表記で出す (#172)。
        const a = analysisByTrack.get(t.trackId);
        const k = effectiveKeyCamelot(t, a);
        if (!k) return null;
        const overridden = isKeyOverridden(t, a);
        const desc = describeKey(k) ?? k;
        return (
          <span
            className="cb-fmono"
            style={{ color: "var(--ac)", fontWeight: 600 }}
            title={overridden ? `${desc}（手動設定）` : desc}
          >
            {formatKey(k, keyNotation)}
            {overridden && "*"}
          </span>
        );
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
    <div className="cb-list" ref={parentRef} onClick={closeMenu}>
      {/* Column header */}
      <div className="cb-head" ref={headRef} style={{ minWidth: rowMinWidth }}>
        <span
          ref={nameHeadRef}
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
            if (suppressNextSortClick.current) {
              suppressNextSortClick.current = false;
              return;
            }
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
            onPointerDown={onNameResizePointerDown}
            onPointerMove={onNameResizePointerMove}
            onPointerUp={onNameResizePointerUp}
            onClick={(e) => e.stopPropagation()}
          />
        </span>
        {fields.map((id, index) => {
          const def = FIELD_DEFS[id];
          const isSorted = def.sortField !== null && def.sortField === sortField;
          const width = fieldWidths[id] ?? def.width;
          const isDragging = colDragRef.current?.moved && colDragRef.current.from === index;
          return (
            <span
              key={id}
              data-col-index={index}
              className={
                "cb-h-f cb-h-drag" +
                (isSorted ? " sorted" : "") +
                (isDragging ? " dragging" : "") +
                (dropIndicator === index ? " dropbefore" : "")
              }
              style={{ width }}
              title="ドラッグで並べ替え / 右端でリサイズ"
              onPointerDown={(e) => onHeadPointerDown(e, index)}
              onPointerMove={onHeadPointerMove}
              onPointerUp={onHeadPointerUp}
              onClick={(e) => {
                e.stopPropagation();
                // リサイズ / 並べ替え直後の click はソートとして扱わない。
                if (suppressNextSortClick.current) {
                  suppressNextSortClick.current = false;
                  return;
                }
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
                onPointerDown={(e) => onResizePointerDown(e, id)}
                onPointerMove={onResizePointerMove}
                onPointerUp={onResizePointerUp}
                onClick={(e) => e.stopPropagation()}
              />
            </span>
          );
        })}
        {/* 末尾へのドロップ位置インジケータ。 */}
        {dropIndicator === fields.length && <span className="cb-h-droplast" />}
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
          const isDragging = draggingIds?.has(t.trackId) ?? false;
          // 挿入線: dropIndex の行の手前へ。末尾へのドロップだけ最終行の下に出す。
          const dropBefore = manualReorder && dropIndex === virtualRow.index;
          const dropAfter =
            manualReorder &&
            dropIndex === list.count &&
            virtualRow.index === list.count - 1;
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
              onDragEnd={clearRowDrag}
              onDragOver={(e) => handleRowDragOver(e, virtualRow.index)}
              onDrop={handleRowDrop}
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
                  {renderField(id, t, virtualRow.index)}
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
          tracks={deleteTargets}
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
