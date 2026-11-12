import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as libraryApi from "../api/library";
import * as playlistsApi from "../api/playlists";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { ColumnPicker } from "./ColumnPicker";
import { SmartRestoreDialog } from "./SmartRestoreDialog";
import type { LibraryStats, SortField, ViewMode } from "../types";
import { ALBUM_SORT_FIELDS, ARTIST_SORT_FIELDS } from "../types";
import { AUDIO_EXTENSIONS } from "../lib/audioExtensions";
import {
  importWithDuplicateCheck,
  registerImportHandler,
  summarizeImport,
} from "../lib/importFlow";

interface ToolbarProps {
  onLibraryChanged: () => void;
  onOpenRipDialog: () => void;
  onOpenRulesPanel: () => void;
  onOpenSyncProvision: () => void;
  onOpenUsbExport: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/// プレイリストの手動順 (DB の sort_index 順)。プレイリスト表示のときだけ選べる。
const PLAYLIST_ORDER_OPTION: { field: SortField; label: string } = {
  field: "playlistOrder",
  label: "Playlist Order",
};

const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: "name", label: "Track" },
  { field: "artist", label: "Artist" },
  { field: "album", label: "Album" },
  { field: "albumArtist", label: "Album Artist" },
  { field: "genre", label: "Genre" },
  { field: "bpm", label: "BPM" },
  { field: "rating", label: "Rating" },
  { field: "year", label: "Year" },
  { field: "playCount", label: "Plays" },
  { field: "totalTimeMs", label: "Time" },
  { field: "trackNumber", label: "Track #" },
  { field: "dateAdded", label: "Date Added" },
  { field: "lastPlayed", label: "Last Played" },
  { field: "codec", label: "Codec" },
  { field: "bitrate", label: "Bitrate" },
  { field: "sampleRate", label: "Sample Rate" },
  { field: "fileSize", label: "Size" },
];

/// Artists ビュー専用のソート候補。アーティスト粒度で意味を持つのは
/// ARTIST_SORT_FIELDS の 3 つだけなので、集合はそちらを単一の真実の源にする。
const ARTIST_SORT_LABELS: Partial<Record<SortField, string>> = {
  name: "Artist",
  trackCount: "Tracks",
  albumCount: "Albums",
};
const ARTIST_SORT_OPTIONS: { field: SortField; label: string }[] =
  ARTIST_SORT_FIELDS.map((f) => ({ field: f, label: ARTIST_SORT_LABELS[f] ?? f }));

// 1 文字でも検索する文字 (かな・カナ・漢字・ハングル・半角カナ)。
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/;

// 完了 status をサブバーから自動で消すまでの時間 (#152)。
const STATUS_CLEAR_MS = 8000;

// ツールバー(行)の実効幅 (= 右ペイン・サイドバーを除いた実際に使える幅) に応じて段階的に畳む。
// - COMPACT_WIDTH 未満: 右側のアクション群を ⋯ メニューに畳む。
// - NARROW_WIDTH 未満: 表示切替・列ボタンをアイコンのみ、ソートは項目名だけにする。
// - TINY_WIDTH 未満: ソートも方向矢印だけにする (項目名はツールチップ)。
// 横スクロールはしない (WebKitGTK ではスクロールバー領域がクリックを奪うため)。
// プレイリスト表示中は検索範囲の切替 (このプレイリスト / ライブラリ全体) が増える分だけ早めに畳む。
const COMPACT_WIDTH = 1200;
const NARROW_WIDTH = 900;
const TINY_WIDTH = 640;
const SCOPE_SEG_EXTRA = 150;
const MORE_MENU_WIDTH = 248;

// ⋯ メニューにも通常のボタンにも同じ定義から描画するためのアクション記述。
interface ToolAction {
  id: string;
  label: string;
  icon: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  on?: boolean;
  primary?: boolean;
  /** 通常表示時にラベルまで出すか（false ならアイコンのみ） */
  showLabel?: boolean;
}

// ツールバーは横スクロールするため、ポップオーバーは fixed で画面基準に置いてクリップを避ける。
function anchoredPopStyle(el: HTMLElement | null, width: number): React.CSSProperties {
  if (!el) return { width };
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
  return { position: "fixed", top: r.bottom + 6, left, width };
}

const VIEW_TITLE: Record<ViewMode, string> = {
  library: "All Tracks",
  inbox: "Inbox",
  history: "Set History",
  artists: "Artists",
  recent: "Recently Played",
  playlist: "Playlist",
};

export function Toolbar({
  onLibraryChanged,
  onOpenRipDialog,
  onOpenRulesPanel,
  onOpenSyncProvision,
  onOpenUsbExport,
  onOpenSettings,
  onOpenHelp,
}: ToolbarProps) {
  const {
    viewMode,
    displayMode,
    setDisplayMode,
    searchQuery,
    setSearchQuery,
    searchScope,
    setSearchScope,
    filterTags,
    removeFilterTag,
    clearFilterTags,
    sortField,
    sortOrder,
    toggleSort,
    setSortField,
    setSortOrder,
    fields,
    selectedPlaylistId,
    playlists,
    tracks,
    selectedTrackIds,
    analysisActive,
    autoExportEnabled,
    autoExportPath,
    setAutoExport,
    rightRailVisible,
    toggleRightRail,
  } = useStore();

  const [importing, setImporting] = useState(false);
  // iTunes XML からスマートプレイリストを復元するダイアログ。
  const [smartRestoreOpen, setSmartRestoreOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  const [importingFolders, setImportingFolders] = useState(false);
  const [checkingFiles, setCheckingFiles] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [status, setStatusRaw] = useState("");
  const statusTimerRef = useRef<number | null>(null);

  /**
   * サブバーの status を出す (#152)。
   * 完了メッセージは出しっぱなしにせず STATUS_CLEAR_MS 後に自動で消す。
   * 進行中 ("…" で終わる / "…中") とエラーは、次の status が来るまで残す。
   */
  const setStatus = useCallback((text: string) => {
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatusRaw(text);
    if (!text) return;
    const inProgress = text.endsWith("…") || text.includes("…中");
    // 取り込み結果の「失敗 0」は失敗ではないので自動で消す。
    const isError = /error|失敗(?!\s*0(?!\d))/i.test(text);
    if (inProgress || isError) return;
    statusTimerRef.current = window.setTimeout(() => {
      statusTimerRef.current = null;
      setStatusRaw("");
    }, STATUS_CLEAR_MS);
  }, []);

  // アンマウント時にタイマーを片付ける。
  useEffect(
    () => () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
    },
    [],
  );
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // ツールバー行の実効幅。幅に応じてアクション群を ⋯ に畳み、ラベルを段階的に省く。
  const [rowWidth, setRowWidth] = useState(Number.POSITIVE_INFINITY);
  const scopeExtra = viewMode === "playlist" ? SCOPE_SEG_EXTRA : 0;
  const compact = rowWidth < COMPACT_WIDTH;
  const narrow = rowWidth < NARROW_WIDTH + scopeExtra;
  const tiny = rowWidth < TINY_WIDTH + scopeExtra;
  // 検索ボックス: 表示用ローカル state（即時反映）。store への反映はデバウンス。
  const [localSearch, setLocalSearch] = useState(searchQuery);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const isListLike = viewMode !== "artists";

  // ツールバー幅を監視して畳み具合を切り替える（初回描画前に確定させたいので layout effect）。
  // 行の幅は右ペインの表示・リサイズに追従する (grid の中央列の幅)。
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    setRowWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setRowWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 広くなって ⋯ ボタン自体が消える場合はメニューも閉じる。
  useEffect(() => {
    if (!compact) setMoreOpen(false);
  }, [compact]);

  // メニューを開いたら先頭項目にフォーカス。
  useEffect(() => {
    if (!moreOpen) return;
    const first = moreMenuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    first?.focus();
  }, [moreOpen]);

  // Esc で閉じる / 上下キーで移動。
  const handleMoreKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setMoreOpen(false);
      moreBtnRef.current?.focus();
      return;
    }
    const items = Array.from(
      moreMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        e.key === "ArrowDown"
          ? (cur + 1) % items.length
          : (cur - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await libraryApi.getLibraryStats());
    } catch {
      setStats(null);
    }
  }, []);

  // 曲数だけでなくプレイリストの増減 (作成・削除) でも統計を取り直す。
  useEffect(() => {
    refreshStats();
  }, [refreshStats, tracks.length, playlists.length]);

  useEffect(() => {
    libraryApi
      .getLibraryRoot()
      .then((r) => setLibraryRoot(r))
      .catch(() => setLibraryRoot(null));
  }, []);

  const handleSetLibraryRoot = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      await libraryApi.setLibraryRoot(dir);
      setLibraryRoot(dir);
      setStatus(`整理先を設定: ${dir}`);
    } catch (err) {
      setStatus(`整理先の設定に失敗: ${err}`);
    }
  }, []);

  // store の searchQuery が外部（Ctrl+L / Escape など）で変わったら表示も同期する。
  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // 表示は即時反映（制御入力）
      setLocalSearch(value);
      // store 反映はデバウンス。英数 1 文字は候補が多すぎるので検索しないが、
      // 前の検索結果を残さないよう検索自体は解除する。CJK は 1 文字でも意味があるので検索する。
      clearTimeout(searchTimer.current);
      const trimmed = value.trim();
      const effective = [...trimmed].length === 1 && !CJK_CHAR.test(trimmed) ? "" : value;
      searchTimer.current = setTimeout(() => {
        // 表示中のビューは変えない。プレイリスト表示中は検索スコープ
        // （このプレイリスト / ライブラリ全体）が対象を決める。
        setSearchQuery(effective);
      }, 300);
    },
    [setSearchQuery],
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setLocalSearch("");
        setSearchQuery("");
        (e.target as HTMLInputElement).blur();
      }
    },
    [setSearchQuery],
  );

  // 検索クリア(×)ボタン: store をクリアし入力にフォーカスを戻す。
  const handleClearSearch = useCallback(() => {
    clearTimeout(searchTimer.current);
    setLocalSearch("");
    setSearchQuery("");
    searchInputRef.current?.focus();
  }, [setSearchQuery]);

  const handleImport = useCallback(async () => {
    const path = await open({ filters: [{ name: "iTunes Library XML", extensions: ["xml"] }] });
    if (!path) return;
    setImporting(true);
    setStatus("取り込み中…");
    try {
      const r = await libraryApi.importLibrary(path as string);
      setStatus(
        `${r.trackCount} 曲・${r.playlistCount} プレイリストを取り込みました` +
          (r.missingFiles > 0 ? `（ファイルなし ${r.missingFiles} 曲）` : ""),
      );
      onLibraryChanged();
      refreshStats();
    } catch (err) {
      setStatus(`取り込みに失敗しました: ${err}`);
    } finally {
      setImporting(false);
    }
  }, [onLibraryChanged, refreshStats]);

  // ファイル / フォルダ取り込みの共通処理: 取り込み済み検出 → (衝突があれば確認) → 取り込み。
  const runImportWithDuplicateCheck = useCallback(
    async (paths: string[]) => {
      const r = await importWithDuplicateCheck(paths, { onStatus: setStatus });
      if (!r) {
        setStatus("取り込みをキャンセルしました");
        return;
      }
      const total = r.imported + r.skipped + r.replaced + r.failed;
      if (total === 0) {
        setStatus("対応ファイルなし");
        useStore.getState().pushToast("info", "対応フォーマットのファイルが見つかりませんでした");
        return;
      }
      const summary = summarizeImport(r);
      setStatus(summary);
      const changed = r.imported + r.replaced > 0;
      useStore
        .getState()
        .pushToast(
          r.failed > 0 ? "error" : changed ? "success" : "info",
          r.imported > 0
            ? `${summary} — Inbox に追加されました。サイドバーの Inbox から整理できます`
            : summary,
          changed ? 5200 : 3200,
        );
      if (changed) {
        onLibraryChanged();
        refreshStats();
      }
    },
    [onLibraryChanged, refreshStats, setStatus],
  );

  const handleImportFiles = useCallback(async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Audio files",
          extensions: [...AUDIO_EXTENSIONS],
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setImportingFiles(true);
    setStatus(`${paths.length} ファイルを照合中…`);
    try {
      await runImportWithDuplicateCheck(paths as string[]);
    } catch (err) {
      setStatus(`ファイルの取り込みに失敗しました: ${err}`);
      useStore.getState().pushToast("error", `取り込みエラー: ${err}`);
    } finally {
      setImportingFiles(false);
    }
  }, [runImportWithDuplicateCheck]);

  // フォルダを選んで再帰的に取り込む (対応拡張子だけを Rust 側が拾う)。
  const handleImportFolders = useCallback(async () => {
    const selected = await open({ directory: true, multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setImportingFolders(true);
    setStatus(`${paths.length} フォルダを走査中…`);
    try {
      await runImportWithDuplicateCheck(paths);
    } catch (err) {
      setStatus(`フォルダの取り込みに失敗しました: ${err}`);
      useStore.getState().pushToast("error", `フォルダ取り込みエラー: ${err}`);
    } finally {
      setImportingFolders(false);
    }
  }, [runImportWithDuplicateCheck]);

  // 空状態のボタン (EmptyState) からの取り込み要求をツールバーと同じ処理で受ける。
  useEffect(
    () =>
      registerImportHandler((kind) => {
        if (kind === "folder") void handleImportFolders();
        else if (kind === "files") void handleImportFiles();
        else void handleImport();
      }),
    [handleImportFolders, handleImportFiles, handleImport],
  );

  const handleExport = useCallback(async () => {
    const path = await save({
      filters: [{ name: "iTunes Library XML", extensions: ["xml"] }],
      defaultPath: "iTunes Library.xml",
    });
    if (!path) return;
    setExporting(true);
    setStatus("書き出し中…");
    try {
      const r = await libraryApi.exportLibrary(path);
      // 自動エクスポートの出力先として記憶する。
      setAutoExport(autoExportEnabled, path);
      setStatus(`${r.trackCount} 曲を書き出しました → ${r.outputPath}`);
    } catch (err) {
      setStatus(`書き出しに失敗しました: ${err}`);
    } finally {
      setExporting(false);
    }
  }, [autoExportEnabled, setAutoExport]);

  // ライブラリ全曲の実ファイル有無を確認し直す (リンク切れ再チェック)。
  // 状態が変わった曲があれば Rust 側が library-changed を送るので、一覧はそちらで再読み込みされる。
  const handleRescanFiles = useCallback(async () => {
    setCheckingFiles(true);
    setStatus("リンク切れを確認中…");
    const unlisten = await libraryApi.onFileCheckProgress(({ done, total }) => {
      setStatus(`リンク切れを確認中 ${done.toLocaleString()}/${total.toLocaleString()}…`);
    });
    try {
      const r = await libraryApi.rescanFileExistence();
      // 前回からの変化 (新たに欠損 / 復帰) があれば括弧書きで添える。
      const changes = [
        r.newlyMissing > 0 ? `新たに ${r.newlyMissing.toLocaleString()} 曲` : "",
        r.newlyFound > 0 ? `${r.newlyFound.toLocaleString()} 曲が復帰` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      setStatus(
        r.missing > 0
          ? `${r.missing.toLocaleString()} 曲のファイルが見つかりません` +
              (changes ? `（${changes}）` : "") +
              " — 検索で missing:yes と入力すると一覧できます"
          : `全 ${r.checked.toLocaleString()} 曲のファイルを確認しました（リンク切れなし）` +
              (changes ? `（${changes}）` : ""),
      );
    } catch (err) {
      setStatus(`リンク切れの再チェックに失敗: ${err}`);
    } finally {
      unlisten();
      setCheckingFiles(false);
    }
  }, [setStatus]);

  // iTunes 互換 XML の自動エクスポートを ON/OFF。ON 時にパス未設定なら出力先を聞く。
  const handleToggleAutoExport = useCallback(async () => {
    if (autoExportEnabled) {
      setAutoExport(false, autoExportPath);
      setStatus("自動エクスポート: OFF");
      return;
    }
    let path = autoExportPath;
    if (!path) {
      const picked = await save({
        filters: [{ name: "iTunes Library XML", extensions: ["xml"] }],
        defaultPath: "iTunes Library.xml",
      });
      if (!picked) return;
      path = picked;
    }
    setAutoExport(true, path);
    setStatus(`自動エクスポート: ON（${path}）`);
  }, [autoExportEnabled, autoExportPath, setAutoExport]);

  // View title + subcount.
  const activePlaylist =
    viewMode === "playlist"
      ? playlists.find((p) => p.playlistId === selectedPlaylistId)
      : null;
  const isSearching = !!searchQuery || filterTags.length > 0;
  // スマートプレイリスト / フォルダの実際の曲数。playlists の trackCount は静的な
  // playlist_tracks の行数なのでスマートでは 0 になる → 表示中にライブ評価で数える。
  const [liveCount, setLiveCount] = useState<{ id: number; count: number } | null>(null);
  const needsLiveCount = !!activePlaylist && (activePlaylist.isSmart || activePlaylist.isFolder);
  const activePlaylistId = activePlaylist?.playlistId ?? null;
  useEffect(() => {
    if (!needsLiveCount || activePlaylistId == null) return;
    let cancelled = false;
    playlistsApi
      .getPlaylistTrackCount(activePlaylistId)
      .then((count) => {
        if (!cancelled) setLiveCount({ id: activePlaylistId, count });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // tracks が読み直されたら (ライブラリ変更・条件編集) 数え直す。
  }, [needsLiveCount, activePlaylistId, tracks]);
  const title = isSearching
    ? "検索結果"
    : activePlaylist
      ? activePlaylist.name
      : VIEW_TITLE[viewMode];
  // Artists ビューは tracks を全件持たない (サーバ集約) ので、件数はライブラリ統計を使う
  // (アーティスト数を出す)。スマート / フォルダはライブ評価した曲数。
  const playlistCount =
    activePlaylist && needsLiveCount
      ? liveCount?.id === activePlaylist.playlistId
        ? liveCount.count
        : null
      : (activePlaylist?.trackCount ?? null);
  const subCount = isSearching
    ? `${tracks.length.toLocaleString()} 曲`
    : activePlaylist
      ? playlistCount != null
        ? `${playlistCount.toLocaleString()} 曲`
        : "…"
      : viewMode === "artists"
        ? stats
          ? `${stats.artistCount.toLocaleString()} アーティスト`
          : "…"
        : viewMode === "library" && stats
          ? `${stats.trackCount.toLocaleString()} 曲`
          : `${tracks.length.toLocaleString()} 曲`;

  // Albums モードはアルバム粒度のソートのみ (ALBUM_SORT_FIELDS の順序を維持)。
  const albumSortOptions = ALBUM_SORT_FIELDS.map(
    (f) => SORT_OPTIONS.find((o) => o.field === f)!,
  );
  // 手動順は「通常プレイリストを List 表示していて、検索していない」ときだけ。
  const manualSortAvailable =
    displayMode === "list" &&
    !isSearching &&
    !!activePlaylist &&
    !activePlaylist.isSmart &&
    !activePlaylist.isFolder;
  // Artists ビューはアーティスト粒度、Albums 表示モードはアルバム粒度の語彙に絞る。
  const sortOptions = !isListLike
    ? ARTIST_SORT_OPTIONS
    : displayMode === "albums"
      ? albumSortOptions
      : manualSortAvailable
        ? [PLAYLIST_ORDER_OPTION, ...SORT_OPTIONS]
        : SORT_OPTIONS;
  const curSort = sortOptions.find((s) => s.field === sortField);
  // 手動順に昇順/降順は無い（常に保存された並び）。
  const manualSortActive = sortField === "playlistOrder";

  // 幅が足りないときに ⋯ メニューへ畳むアクション群（挙動は畳んでも同じ）。
  const overflowActions: ToolAction[] = [
    {
      id: "sync",
      label: "サーバーから取り寄せ",
      icon: "download",
      title: "接続済みサーバーからプレイリストと曲を取り寄せる",
      onClick: onOpenSyncProvision,
      showLabel: true,
    },
    {
      id: "usbExport",
      label: "USB に書き出し",
      icon: "upload",
      title: "プレイリストを CDJ 用 USB (rekordbox 互換) に書き出す",
      onClick: onOpenUsbExport,
    },
    {
      id: "import",
      label: "iTunes XML を取り込む",
      icon: "download",
      title: "既存の iTunes Library.xml を取り込む",
      onClick: handleImport,
      disabled: importing,
      primary: true,
    },
    {
      id: "restoreSmart",
      label: "iTunes XML からスマートプレイリストを復元…",
      icon: "sliders",
      title:
        "iTunes XML からスマートプレイリストを復元…\n" +
        "取り込み済みのプレイリストに iTunes の条件だけを設定し直す (曲・プレイリストは取り込まない)",
      onClick: () => setSmartRestoreOpen(true),
    },
    {
      id: "importFiles",
      label: "ファイルを追加",
      icon: "filePlus",
      title: "音楽ファイルをライブラリに追加",
      onClick: handleImportFiles,
      disabled: importingFiles,
    },
    {
      id: "importFolders",
      label: "フォルダを追加",
      icon: "folder",
      title: "フォルダを丸ごと取り込む (サブフォルダも再帰的に走査)",
      onClick: handleImportFolders,
      disabled: importingFolders,
    },
    {
      id: "rip",
      label: "CD を取り込む",
      icon: "disc",
      title: "音楽 CD を取り込む (リッピング)",
      onClick: onOpenRipDialog,
    },
    {
      id: "rules",
      label: "プレイリストルール (Rules)",
      icon: "layers",
      title: "YAML のルールからスマートプレイリストを作る",
      onClick: onOpenRulesPanel,
    },
    {
      id: "libraryRoot",
      label: "整理先フォルダ",
      icon: "folderPlus",
      title: libraryRoot
        ? `整理先 (編集時に自動でフォルダ分け): ${libraryRoot}\nクリックで変更`
        : "整理先フォルダを設定 (未設定だと自動整理オフ)",
      onClick: handleSetLibraryRoot,
      on: !!libraryRoot,
    },
    {
      id: "export",
      label: "iTunes XML に書き出し",
      icon: "upload",
      title: "ライブラリを iTunes 互換の XML に書き出す",
      onClick: handleExport,
      disabled: exporting || (stats?.trackCount ?? 0) === 0,
    },
    {
      id: "autoExport",
      label: "自動エクスポート",
      icon: "clock",
      title: autoExportEnabled
        ? `自動 XML エクスポート: ON\n${autoExportPath ?? ""}\n(変更時に約30分間隔＋終了時に自動書き出し)\nクリックで OFF`
        : "iTunes 互換 XML を自動エクスポート (変更時のみ・約30分間隔＋終了時)",
      onClick: handleToggleAutoExport,
      on: autoExportEnabled,
    },
    {
      id: "rescanFiles",
      label: "リンク切れを再チェック",
      icon: "warning",
      title:
        "全曲のファイルが今もあるか確認し直す (外付けドライブの接続後など)\n" +
        "見つからない曲は検索で missing:yes と入力すると一覧できます",
      onClick: handleRescanFiles,
      disabled: checkingFiles || (stats?.trackCount ?? 0) === 0,
    },
  ];


  return (
    <>
      <div className="cb-tb">
        {/* 横スクロールはさせず、幅に応じて段階的に畳む。アクション群は右端に固定し、
            はみ出す場合は左側 (検索・表示切替) の側を詰める。 */}
        <div className="cb-tb-row" ref={rowRef}>
          <div className="cb-tb-main">
          <div className="cb-sbox" style={{ position: "relative" }}>
            <Icon name="search" size={15} />
            <input
              id="search-input"
              ref={searchInputRef}
              type="text"
              placeholder={
                '検索… artist:"daft punk"  genre:house  year:2015-2020  rating:4-5  ' +
                "bpm:120-128  key:compat:8A  tag:mood:dreamy  analyzed:no  missing:yes  (/ or Ctrl+F)"
              }
              value={localSearch}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
            {/* 検索文字がある時だけ × を表示 */}
            {localSearch && (
              <button
                onClick={handleClearSearch}
                title="検索をクリア"
                style={{
                  position: "absolute",
                  right: 6,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 4px",
                  color: "var(--tx2)",
                  lineHeight: 1,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <Icon name="x" size={13} />
              </button>
            )}
          </div>

          {/* プレイリスト表示中だけ出す検索スコープ切り替え。既定はこのプレイリスト内。 */}
          {viewMode === "playlist" && (
            <div className="cb-seg2" role="group" aria-label="検索範囲">
              <button
                className={"cb-segb2" + (searchScope === "playlist" ? " on" : "")}
                onClick={() => setSearchScope("playlist")}
                title="このプレイリストの中だけを検索"
                aria-pressed={searchScope === "playlist"}
              >
                {narrow ? "プレイリスト" : "このプレイリスト"}
              </button>
              <button
                className={"cb-segb2" + (searchScope === "library" ? " on" : "")}
                onClick={() => setSearchScope("library")}
                title="ライブラリ全体を検索"
                aria-pressed={searchScope === "library"}
              >
                {narrow ? "全体" : "ライブラリ全体"}
              </button>
            </div>
          )}

          <div className="cb-seg">
            <button
              className={"cb-segb" + (displayMode === "list" ? " on" : "")}
              onClick={() => setDisplayMode("list")}
              title="リスト表示"
              aria-label="リスト表示"
            >
              <Icon name="list" size={14} />
              {!narrow && " List"}
            </button>
            <button
              className={"cb-segb" + (displayMode === "albums" ? " on" : "")}
              onClick={() => setDisplayMode("albums")}
              title="アルバム表示"
              aria-label="アルバム表示"
            >
              <Icon name="grid" size={14} />
              {!narrow && " Albums"}
            </button>
            <button
              className={"cb-segb" + (displayMode === "tracks" ? " on" : "")}
              onClick={() => setDisplayMode("tracks")}
              title="トラックウォール表示"
              aria-label="トラックウォール表示"
            >
              <Icon name="disc" size={14} />
              {!narrow && " Tracks"}
            </button>
          </div>

          <div style={{ position: "relative" }}>
            <button
              ref={sortBtnRef}
              className={"cb-btn" + (sortOpen ? " on" : "")}
              onClick={() => {
                setSortOpen((v) => !v);
                setPickerOpen(false);
                setMoreOpen(false);
              }}
              title={`並び順: ${curSort?.label ?? "—"}`}
            >
              {/* ソートフィールド名＋現在の昇順/降順を常時表示 (狭いときは項目名を省く) */}
              {tiny ? "" : narrow ? `${curSort?.label ?? "—"} ` : `Sort: ${curSort?.label ?? "—"} `}
              {manualSortActive ? (tiny ? "≡" : "") : sortOrder === "asc" ? "↑" : "↓"}
              <Icon name="chevronD" size={12} />
            </button>
            {sortOpen && (
              <>
                <div className="cb-scrim" onClick={() => setSortOpen(false)} />
                <div className="cb-sortpop" style={anchoredPopStyle(sortBtnRef.current, 200)}>
                  {sortOptions.map((s) => {
                    const on = s.field === sortField;
                    return (
                      <div
                        key={s.field}
                        className={"cb-sortitem" + (on ? " on" : "")}
                        onClick={() => {
                          // 手動順は方向を持たないので、トグルせず昇順で固定する。
                          if (s.field === "playlistOrder") {
                            setSortField("playlistOrder");
                            setSortOrder("asc");
                          } else {
                            toggleSort(s.field);
                          }
                        }}
                      >
                        {s.label}
                        {on && s.field !== "playlistOrder" && (
                          <span className="dir">
                            <Icon name="chevronD" size={12} style={{ transform: sortOrder === "asc" ? "rotate(180deg)" : undefined }} />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {isListLike && displayMode === "list" && (
            <>
              <button
                className={"cb-btn" + (pickerOpen ? " on" : "")}
                data-colpicker-toggle
                onClick={() => {
                  setPickerOpen((v) => !v);
                  setSortOpen(false);
                  setMoreOpen(false);
                }}
                title="表示する列を選ぶ"
                aria-label="表示する列を選ぶ"
              >
                <Icon name="sliders" size={15} />
                {!narrow && " Columns"}
                <span className="cb-btn-badge">{fields.length}</span>
              </button>
            </>
          )}

          </div>

          <div className="cb-tb-actions">
            {/* 幅に余裕があるときは従来どおり横並び、狭いときは ⋯ メニューに畳む。 */}
            {!compact &&
              overflowActions.map((a) => (
                <button
                  key={a.id}
                  className={
                    "cb-btn" +
                    (a.showLabel ? "" : " cb-btn-iconly") +
                    (a.primary ? " primary" : "") +
                    (a.on ? " on" : "")
                  }
                  onClick={a.onClick}
                  disabled={a.disabled}
                  title={a.title}
                >
                  <Icon name={a.icon} size={a.showLabel ? 15 : 16} />
                  {a.showLabel && a.label}
                </button>
              ))}
            {compact && (
              <>
                <button
                  ref={moreBtnRef}
                  className={"cb-btn cb-btn-iconly" + (moreOpen ? " on" : "")}
                  onClick={() => {
                    setMoreOpen((v) => !v);
                    setSortOpen(false);
                    setPickerOpen(false);
                  }}
                  title="その他の操作"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                >
                  <Icon name="more" size={16} />
                </button>
                {moreOpen && (
                  <>
                    <div className="cb-scrim" onClick={() => setMoreOpen(false)} />
                    <div
                      ref={moreMenuRef}
                      className="cb-sortpop cb-morepop"
                      role="menu"
                      aria-label="その他の操作"
                      style={anchoredPopStyle(moreBtnRef.current, MORE_MENU_WIDTH)}
                      onKeyDown={handleMoreKeyDown}
                    >
                      {overflowActions.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          role="menuitem"
                          className={"cb-sortitem" + (a.on ? " on" : "")}
                          onClick={() => {
                            setMoreOpen(false);
                            a.onClick();
                          }}
                          disabled={a.disabled}
                          title={a.title}
                        >
                          <Icon name={a.icon} size={15} />
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <button
              className={"cb-btn cb-btn-iconly" + (rightRailVisible ? " on" : "")}
              onClick={toggleRightRail}
              title={
                rightRailVisible
                  ? "右ペイン (Now Playing / Crate) を隠す"
                  : "右ペイン (Now Playing / Crate) を表示"
              }
            >
              <Icon name="eye" size={16} />
            </button>
            <button
              className="cb-btn cb-btn-iconly cb-btn-q"
              onClick={onOpenHelp}
              title="キーボードショートカット一覧 (?)"
              aria-label="キーボードショートカット一覧"
            >
              ?
            </button>
            <button
              className="cb-btn cb-btn-iconly"
              onClick={onOpenSettings}
              title="設定"
            >
              <Icon name="settings" size={16} />
            </button>
          </div>
        </div>

        {pickerOpen && <ColumnPicker onClose={() => setPickerOpen(false)} />}
      </div>

      <div className="cb-subbar">
        <span className="cb-title">{title}</span>
        <span className="cb-titlesub">· {subCount}</span>
        {selectedTrackIds.size > 0 && (
          <span className="cb-titlesel">· {selectedTrackIds.size.toLocaleString()} 曲を選択中</span>
        )}
        <div className="cb-stats">
          {analysisActive && (
            <span className="cb-status">
              解析中 {analysisActive.done}/{analysisActive.total}
            </span>
          )}
          {status && <span className="cb-status">{status}</span>}
          {stats && (
            <>
              <span>
                <b>{stats.trackCount.toLocaleString()}</b> 曲
              </span>
              <span>·</span>
              <span>
                <b>{stats.playlistCount.toLocaleString()}</b> プレイリスト
              </span>
              {stats.totalTimeMs > 0 && (
                <>
                  <span>·</span>
                  <span>{formatDuration(stats.totalTimeMs)}</span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {filterTags.length > 0 && (
        <div className="cb-filterbar">
          <Icon name="filter" size={14} />
          {filterTags.map((t) => (
            <button
              key={t}
              className="cb-fchip"
              title={`「${t}」を外す`}
              onClick={() => removeFilterTag(t)}
            >
              {t}
              <Icon name="x" size={12} />
            </button>
          ))}
          <button className="cb-fclear" onClick={clearFilterTags}>
            すべて外す
          </button>
        </div>
      )}

      {smartRestoreOpen && (
        <SmartRestoreDialog
          onClose={() => setSmartRestoreOpen(false)}
          onRestored={() => {
            setStatus("iTunes XML からスマートプレイリストを復元しました");
            onLibraryChanged();
          }}
        />
      )}
    </>
  );
}
