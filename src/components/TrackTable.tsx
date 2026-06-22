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
    setSimilarBase,
    nameColWidth,
    setNameColWidth,
  } = useStore();
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);

  const parentRef = useRef<HTMLDivElement>(null);
  // 範囲選択の起点（Shift の基準）と、矢印移動のカーソル位置。
  const anchorIdRef = useRef<number | null>(null);
  const focusIdRef = useRef<number | null>(null);

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
        pushToast("error", `追加に失敗しました: ${err}`);
      }
      setContextMenu(null);
    },
    [ctxIds, pushRecentPlaylist, onTracksChanged, pushToast],
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
        pushToast("error", `削除に失敗しました: ${err}`);
      }
      setContextMenu(null);
    },
    [viewMode, selectedPlaylistId, onTracksChanged, pushToast],
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

  // 「次に再生」: 各曲を現在曲の直後へ割り込ませる。enqueueTrackNext は一曲ずつ
  // 現在曲の直後に挿入するため、選択順のまま回すと後の曲ほど前へ来て逆順になる。
  // ids を反転してから入れると、最終的な並びが選択順どおりになる。
  const handlePlayNext = useCallback(async () => {
    const ids = ctxIds();
    for (const id of [...ids].reverse()) await playbackApi.enqueueTrackNext(id);
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
      pushToast("error", `タグの追加に失敗しました: ${err}`);
    }
    setShowAddTagDialog(false);
    setNewTag("");
    setContextMenu(null);
  }, [newTag, ctxIds, onTracksChanged, pushToast]);

  const handleRemoveGenreTag = useCallback(
    async (tag: string) => {
      try {
        await libraryApi.removeGenreTag(ctxIds(), tag);
        onTracksChanged();
      } catch (err) {
        pushToast("error", `タグの削除に失敗しました: ${err}`);
      }
      setContextMenu(null);
    },
    [ctxIds, onTracksChanged, pushToast],
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
      pushToast("error", `ジャンルの保存に失敗しました: ${err}`);
    }
  }, [genreEdit, onTracksChanged, pushToast]);

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
      // フォーカス行を優先し、無ければ最初の選択行を基準にする。
      const focused =
        focusIdRef.current != null && selectedTrackIds.has(focusIdRef.current)
          ? tracks.find((t) => t.trackId === focusIdRef.current)
          : undefined;
      const sel = focused ?? tracks.find((t) => selectedTrackIds.has(t.trackId));
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

      // Enter: フォーカス行（無ければ選択先頭）の曲を再生。
      if (e.key === "Enter" && !cmd) {
        // フォーカス → 選択先頭 の順でフォールバック。
        let track = ts.find((t) => t.trackId === focusIdRef.current);
        if (!track) track = ts.find((t) => st.selectedTrackIds.has(t.trackId));
        if (!track || !track.fileExists) return;
        e.preventDefault();
        const ids = ts.map((t) => t.trackId);
        const startIndex = ids.indexOf(track.trackId);
        playbackApi
          .setQueue(ids, Math.max(0, startIndex))
          .then(() => playbackApi.playTrack(track!.trackId))
          .catch((err) => console.error("Failed to play:", err));
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

  const renderField = (id: FieldKey, t: Track, rowIndex: number): React.ReactNode => {
    switch (id) {
      case "rowIndex":
        // 現在の表示順での連番 (1 始まり)。アルバムの trackNumber とは別物。
        return <span className="cb-fmono cb-dim">{rowIndex + 1}</span>;
      case "bpm":
        return t.bpm != null ? (
          <span className="cb-fmono" style={{ color: bpmColor(t.bpm), fontWeight: 650 }}>
            {t.bpm}
          </span>
        ) : null;
      case "album":
        return <span className="cb-v ell" title={t.album || ""}>{t.album || ""}</span>;
      case "albumArtist":
        return <span className="cb-v ell" title={t.albumArtist || ""}>{t.albumArtist || ""}</span>;
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
      <div className="cb-head" ref={headRef}>
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
          Track
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
        {/* 選択件数 / 全件数の控えめな表示。右端の add 列の手前に置く。 */}
        <span
          style={{
            marginLeft: "auto",
            paddingLeft: 10,
            paddingRight: 4,
            flexShrink: 0,
            color: "var(--mut)",
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.3px",
            textTransform: "none",
          }}
          title="選択件数 / 全件数"
        >
          {selectedTrackIds.size > 0
            ? `${selectedTrackIds.size}選択 / ${tracks.length}曲`
            : `${tracks.length}曲`}
        </span>
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
                      <span className="cb-warn" title="File not found">
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

      {isLoading && (
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
          <span>Loading… ({tracks.length}曲)</span>
        </div>
      )}
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
          onPlayNext={handlePlayNext}
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
