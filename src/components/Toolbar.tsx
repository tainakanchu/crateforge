import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as libraryApi from "../api/library";
import * as playlistsApi from "../api/playlists";
import { useStore } from "../store/useStore";
import { useTrackListCount } from "../hooks/useTrackList";
import { useElementWidth } from "../hooks/useElementWidth";
import { Icon } from "./Icon";
import { ColumnPicker } from "./ColumnPicker";
import { MenuButton } from "./Menu";
import type { MenuEntry } from "./Menu";
import { MAX_FIT_LEVEL, toolbarFold } from "./toolbarFold";
import { command, commandShortcut } from "../commands/registry";
import type { CommandId } from "../commands/registry";
import type { SettingsSection } from "./SettingsDialog";
import { SmartRestoreDialog } from "./SmartRestoreDialog";
import { useArtistsResult } from "./ArtistsView";
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
  onOpenSyncProvision: () => void;
  onOpenUsbExport: () => void;
  /** 設定ダイアログを指定のセクションで開く (状態行から ライブラリ を開く)。 */
  onOpenSettings: (section?: SettingsSection) => void;
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
  label: "プレイリスト順",
};

// 項目名は一覧の列名 (FIELD_DEFS) と同じ呼び方にそろえる (D8)。
const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: "name", label: "曲名" },
  { field: "artist", label: "アーティスト" },
  { field: "album", label: "アルバム" },
  { field: "albumArtist", label: "アルバムアーティスト" },
  { field: "genre", label: "ジャンル" },
  { field: "bpm", label: "BPM" },
  { field: "rating", label: "評価" },
  { field: "year", label: "年" },
  { field: "playCount", label: "再生回数" },
  { field: "totalTimeMs", label: "時間" },
  { field: "trackNumber", label: "曲番号" },
  { field: "dateAdded", label: "追加日" },
  { field: "lastPlayed", label: "最終再生" },
  { field: "codec", label: "コーデック" },
  { field: "bitrate", label: "ビットレート" },
  { field: "sampleRate", label: "サンプルレート" },
  { field: "fileSize", label: "サイズ" },
];

/// Artists ビュー専用のソート候補。アーティスト粒度で意味を持つのは
/// ARTIST_SORT_FIELDS の 3 つだけなので、集合はそちらを単一の真実の源にする。
const ARTIST_SORT_LABELS: Partial<Record<SortField, string>> = {
  name: "アーティスト名",
  trackCount: "曲数",
  albumCount: "アルバム数",
};
const ARTIST_SORT_OPTIONS: { field: SortField; label: string }[] =
  ARTIST_SORT_FIELDS.map((f) => ({ field: f, label: ARTIST_SORT_LABELS[f] ?? f }));

// 1 文字でも検索する文字 (かな・カナ・漢字・ハングル・半角カナ)。
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/;

// 完了 status をサブバーから自動で消すまでの時間 (#152)。
const STATUS_CLEAR_MS = 8000;

// ツールバーは「実際にはみ出したか」を測って段階的に畳む (D1)。幅のしきい値で決めると、
// 日本語ラベル・ソート項目名・検索範囲の切替の有無などで実際の必要幅がずれ、
// 1024 幅 + 右ペインで表示切替/並び順/列ボタンに到達できなくなっていた。
// 畳み段階 (fitLevel) ごとに何を畳むかは toolbarFold.ts (テストで固定) を参照。
// 横スクロールはしない (WebKitGTK ではスクロールバー領域がクリックを奪うため)。
/** 取り込みをバーに出している段階 (< 3) で検索欄に残したい最小幅。 */
const SEARCH_MIN_WITH_ACTIONS = 200;
const MORE_MENU_WIDTH = 260;

// ツールバーは横スクロールするため、ポップオーバーは fixed で画面基準に置いてクリップを避ける。
function anchoredPopStyle(el: HTMLElement | null, width: number): React.CSSProperties {
  if (!el) return { width };
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
  return { position: "fixed", top: r.bottom + 6, left, width };
}

// サイドバーの表記と揃える (D8)。
const VIEW_TITLE: Record<ViewMode, string> = {
  library: "すべての曲",
  inbox: "Inbox",
  history: "セット履歴",
  artists: "アーティスト",
  recent: "最近再生した曲",
  playlist: "プレイリスト",
};

export function Toolbar({
  onLibraryChanged,
  onOpenRipDialog,
  onOpenSyncProvision,
  onOpenUsbExport,
  onOpenSettings,
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
    libraryRevision,
    selectedTrackIds,
    analysisActive,
    autoExportEnabled,
    autoExportPath,
    setAutoExport,
    rightRailVisible,
    toggleRightRail,
  } = useStore();
  // 表示中の曲の一覧の全件数 (一覧と同じ条件で数える。未確定のあいだは null)。
  const listCount = useTrackListCount();

  const [importing, setImporting] = useState(false);
  // iTunes XML からスマートプレイリストを復元するダイアログ。
  const [smartRestoreOpen, setSmartRestoreOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  const [importingFolders, setImportingFolders] = useState(false);
  const [checkingFiles, setCheckingFiles] = useState(false);
  // 整理先フォルダ (undefined = 未取得)。設定ダイアログで変わるので、取り込みメニューを開くたびに読み直す。
  const [libraryRoot, setLibraryRoot] = useState<string | null | undefined>(undefined);
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
  // ツールバー行の実効幅 (右ペインの表示・リサイズに追従) と畳み段階 (上の fitLevel 参照)。
  const [fitLevel, setFitLevel] = useState(0);
  // Web フォントの読み込み完了で文字幅が変わるので測り直す。
  const [fontsTick, setFontsTick] = useState(0);
  const fold = toolbarFold(fitLevel);
  const narrow = fold.controlsIconOnly;
  const { controlsInMenu, scopeInMenu, actionsInMenu, actionsIconOnly } = fold;
  // 検索ボックス: 表示用ローカル state（即時反映）。store への反映はデバウンス。
  const [localSearch, setLocalSearch] = useState(searchQuery);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const isListLike = viewMode !== "artists";

  // ツールバー幅を監視して畳み具合を切り替える（初回描画前に確定させたいので layout effect）。
  // 行の幅は右ペインの表示・リサイズに追従する (grid の中央列の幅)。
  // 計測前は「十分広い」として扱う。
  const { ref: rowRef, width: rowWidth } = useElementWidth<HTMLDivElement>(
    Number.POSITIVE_INFINITY,
  );

  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => {
      if (alive) setFontsTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
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
  }, [refreshStats, libraryRevision, listCount, playlists.length]);

  const refreshLibraryRoot = useCallback(() => {
    libraryApi
      .getLibraryRoot()
      .then((r) => setLibraryRoot(r))
      .catch(() => setLibraryRoot(undefined));
  }, []);
  useEffect(() => {
    refreshLibraryRoot();
  }, [refreshLibraryRoot]);

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
    // ライブラリが変わったら (曲の編集・条件編集) 数え直す。
  }, [needsLiveCount, activePlaylistId, libraryRevision]);
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
  const artistsResult = useArtistsResult();
  // 表示中の曲の一覧の全件数 (読み込み済みの行数ではない)。未確定のあいだは "…"。
  const listCountLabel = listCount !== null ? `${listCount.toLocaleString()} 曲` : "…";
  const subCount = isSearching
    ? viewMode === "artists"
      ? artistsResult.count != null
        ? `${artistsResult.count.toLocaleString()} アーティスト`
        : "…"
      : listCountLabel
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
          : listCountLabel;

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

  // 畳み段階を実測で決める。幅や中身 (ビュー・ソート項目名・列数…) が変わったら
  // 段階 0 からやり直し、左側 (.cb-tb-main) がはみ出している間は 1 段ずつ畳む。
  // layout effect 内の setState は描画前に同期で再描画されるので、途中段階は表示されない。
  const fitKey = [
    Math.round(rowWidth),
    viewMode,
    displayMode,
    curSort?.label ?? "",
    sortOrder,
    fields.length,
    fontsTick,
  ].join("|");
  const lastFitKey = useRef("");
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    if (lastFitKey.current !== fitKey) {
      lastFitKey.current = fitKey;
      if (fitLevel !== 0) {
        setFitLevel(0);
        return;
      }
    }
    // 取り込みをバーに並べる (段階 < 3) のは、検索欄に十分な幅が残るときだけ。
    const sbox = el.querySelector<HTMLElement>(".cb-sbox");
    const searchCramped =
      !actionsInMenu && !!sbox && sbox.getBoundingClientRect().width < SEARCH_MIN_WITH_ACTIONS;
    if ((searchCramped || el.scrollWidth > el.clientWidth + 1) && fitLevel < MAX_FIT_LEVEL) {
      setFitLevel(fitLevel + 1);
    }
  });

  // メニュー項目 (ラベル・アイコンは commands/registry の静的メタデータから引く)。
  const cmdItem = (
    id: CommandId,
    onSelect: () => void,
    extra?: { disabled?: boolean; title?: string },
  ): MenuEntry => {
    const c = command(id);
    return { kind: "item", id, label: c.label, icon: c.icon, onSelect, ...extra };
  };

  // 取り込み ▾ の中身。段階 3 以上では ⋯ の「取り込み」セクションにそのまま入る。
  const importEntries: MenuEntry[] = [
    cmdItem("importFiles", handleImportFiles, {
      disabled: importingFiles,
      title: "音楽ファイルをライブラリに追加",
    }),
    cmdItem("importFolders", handleImportFolders, {
      disabled: importingFolders,
      title: "フォルダを丸ごと取り込む (サブフォルダも再帰的に走査)",
    }),
    cmdItem("ripCd", onOpenRipDialog, { title: "音楽 CD を取り込む (リッピング)" }),
    { kind: "separator", id: "sep-sync" },
    cmdItem("syncProvision", onOpenSyncProvision, {
      title: "接続済みサーバーからプレイリストと曲を取り寄せる",
    }),
    { kind: "separator", id: "sep-itunes" },
    { kind: "section", id: "sec-itunes", label: "iTunes から移行" },
    cmdItem("importItunesXml", handleImport, {
      disabled: importing,
      title: "既存の iTunes Library.xml を取り込む",
    }),
    cmdItem("restoreSmart", () => setSmartRestoreOpen(true), {
      title:
        "取り込み済みのプレイリストに iTunes の条件だけを設定し直す (曲・プレイリストは取り込まない)",
    }),
    // 整理先フォルダが未設定のときだけ状態行を出す (設定済みなら何も出さない)。
    ...(libraryRoot === null
      ? ([
          { kind: "separator", id: "sep-root" },
          {
            kind: "status",
            id: "libraryRoot",
            label: "整理先フォルダ: 未設定",
            tone: "warn",
            title: "設定 › ライブラリ で整理先フォルダを設定します (未設定だと自動整理オフ)",
            onSelect: () => onOpenSettings("library"),
          },
        ] satisfies MenuEntry[])
      : []),
  ];

  // 自動エクスポートの状態行 (設定 › ライブラリ が唯一の設定場所)。
  const autoExportStatus: MenuEntry = {
    kind: "status",
    id: "autoExport",
    label: autoExportEnabled
      ? autoExportPath
        ? "自動エクスポート: オン"
        : "自動エクスポート: 出力先が未設定"
      : "自動エクスポート: オフ",
    tone: autoExportEnabled ? (autoExportPath ? "ok" : "warn") : "off",
    title:
      (autoExportEnabled && autoExportPath ? `${autoExportPath}\n` : "") +
      "設定 › ライブラリ で変更します",
    onSelect: () => onOpenSettings("library"),
  };

  // 表示中のプレイリストがあれば、それを書き出し対象として開く。
  const usbTitle = activePlaylist
    ? `“${activePlaylist.name}” を USB に書き出し`
    : "プレイリストを CDJ 用 USB (rekordbox 互換) に書き出す";

  // ⋯ メニューの中身。畳み段階に応じて、検索範囲・表示・取り込み/書き出しのセクションが加わる。
  const moreEntries = (): MenuEntry[] => {
    const out: MenuEntry[] = [];
    if (scopeInMenu && viewMode === "playlist") {
      out.push({ kind: "section", id: "sec-scope", label: "検索範囲" });
      for (const [scope, label] of [
        ["playlist", "このプレイリスト"],
        ["library", "ライブラリ全体"],
      ] as const) {
        out.push({
          kind: "radio",
          id: `scope-${scope}`,
          label,
          icon: "search",
          checked: searchScope === scope,
          onSelect: () => setSearchScope(scope),
        });
      }
    }
    if (controlsInMenu) {
      out.push({ kind: "section", id: "sec-view", label: "表示" });
      for (const [mode, label, icon] of [
        ["list", "リスト表示", "list"],
        ["albums", "アルバム表示", "grid"],
        ["tracks", "トラックウォール表示", "disc"],
      ] as const) {
        out.push({
          kind: "radio",
          id: `view-${mode}`,
          label,
          icon,
          checked: displayMode === mode,
          onSelect: () => setDisplayMode(mode),
        });
      }
      out.push({
        kind: "item",
        id: "sort",
        icon: "chevronD",
        label:
          `並び順: ${curSort?.label ?? "—"}` +
          (manualSortActive ? "" : sortOrder === "asc" ? " ↑" : " ↓") +
          "…",
        onSelect: () => {
          setPickerOpen(false);
          setSortOpen(true);
        },
      });
      if (isListLike && displayMode === "list") {
        out.push({
          kind: "item",
          id: "columns",
          icon: "sliders",
          label: `表示する列… (${fields.length})`,
          onSelect: () => {
            setSortOpen(false);
            setPickerOpen(true);
          },
        });
      }
    }
    if (actionsInMenu) {
      out.push({ kind: "section", id: "sec-import", label: "取り込み" }, ...importEntries);
      out.push({ kind: "section", id: "sec-export", label: "書き出し" });
    } else if (controlsInMenu || (scopeInMenu && viewMode === "playlist")) {
      out.push({ kind: "section", id: "sec-ops", label: "操作" });
    }
    out.push(
      cmdItem("usbExport", onOpenUsbExport, { title: usbTitle }),
      cmdItem("exportItunesXml", handleExport, {
        disabled: exporting || (stats?.trackCount ?? 0) === 0,
        title: "ライブラリを iTunes 互換の XML に書き出す",
      }),
      autoExportStatus,
      { kind: "separator", id: "sep-rescan" },
      cmdItem("rescanFiles", handleRescanFiles, {
        disabled: checkingFiles || (stats?.trackCount ?? 0) === 0,
        title: "全曲のファイルが今もあるか確認し直す (外付けドライブの接続後など)",
      }),
    );
    return out;
  };

  const railShortcut = commandShortcut("toggleRightPane");

  return (
    <>
      <div className="cb-tb">
        {/* 横スクロールはさせず、幅に応じて段階的に畳む。アクション群は右端に固定し、
            はみ出す場合は左側 (検索・表示切替) の側を詰める。 */}
        <div className="cb-tb-row" ref={rowRef}>
          <div className="cb-tb-main" ref={mainRef}>
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
          {viewMode === "playlist" && !scopeInMenu && (
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

          {!controlsInMenu && (
          <div className="cb-seg">
            <button
              className={"cb-segb" + (narrow ? " iconly" : "") + (displayMode === "list" ? " on" : "")}
              onClick={() => setDisplayMode("list")}
              title="リスト表示"
              aria-label="リスト表示"
            >
              <Icon name="list" size={14} />
              {!narrow && "リスト"}
            </button>
            <button
              className={"cb-segb" + (narrow ? " iconly" : "") + (displayMode === "albums" ? " on" : "")}
              onClick={() => setDisplayMode("albums")}
              title="アルバム表示"
              aria-label="アルバム表示"
            >
              <Icon name="grid" size={14} />
              {!narrow && "アルバム"}
            </button>
            <button
              className={"cb-segb" + (narrow ? " iconly" : "") + (displayMode === "tracks" ? " on" : "")}
              onClick={() => setDisplayMode("tracks")}
              title="トラックウォール表示"
              aria-label="トラックウォール表示"
            >
              <Icon name="disc" size={14} />
              {!narrow && "ウォール"}
            </button>
          </div>
          )}

          <div style={{ position: "relative" }}>
            {!controlsInMenu && (
            <button
              ref={sortBtnRef}
              className={"cb-btn" + (narrow ? " cb-btn-tight" : "") + (sortOpen ? " on" : "")}
              onClick={() => {
                setSortOpen((v) => !v);
                setPickerOpen(false);
              }}
              title={`並び順: ${curSort?.label ?? "—"}`}
            >
              {/* ソートフィールド名＋現在の昇順/降順を常時表示 (狭いときは項目名を省く) */}
              {fold.sortLabel === "arrow"
                ? ""
                : fold.sortLabel === "field"
                  ? `${curSort?.label ?? "—"} `
                  : `並び順: ${curSort?.label ?? "—"} `}
              {manualSortActive ? (fold.sortLabel === "arrow" ? "≡" : "") : sortOrder === "asc" ? "↑" : "↓"}
              <Icon name="chevronD" size={12} />
            </button>
            )}
            {sortOpen && (
              <>
                <div className="cb-scrim" onClick={() => setSortOpen(false)} />
                <div
                  className="cb-sortpop"
                  style={anchoredPopStyle(
                    controlsInMenu ? moreBtnRef.current : sortBtnRef.current,
                    200,
                  )}
                >
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

          {isListLike && displayMode === "list" && !controlsInMenu && (
            <>
              <button
                className={"cb-btn" + (narrow ? " cb-btn-tight" : "") + (pickerOpen ? " on" : "")}
                data-colpicker-toggle
                onClick={() => {
                  setPickerOpen((v) => !v);
                  setSortOpen(false);
                }}
                title="表示する列を選ぶ"
                aria-label="表示する列を選ぶ"
              >
                <Icon name="sliders" size={15} />
                {!narrow && "列"}
                <span className="cb-btn-badge">{fields.length}</span>
              </button>
            </>
          )}

          </div>

          <div className="cb-tb-actions">
            {/* 取り込み ▾ / ⋯ (USB 書き出し・iTunes XML ほか) | 右ペイン (#254)。狭いときは段階的に畳む。 */}
            {!actionsInMenu && (
              <MenuButton
                entries={importEntries}
                menuLabel="取り込み"
                className={"cb-btn" + (actionsIconOnly ? " cb-btn-iconcaret" : "")}
                title="取り込み (ファイル / フォルダ / CD / サーバー / iTunes)"
                ariaLabel="取り込み"
                onOpen={refreshLibraryRoot}
                width={MORE_MENU_WIDTH}
              >
                <Icon name="importTray" size={15} />
                {!actionsIconOnly && "取り込み"}
                <Icon name="chevronD" size={12} className="cb-btn-caret" />
              </MenuButton>
            )}
            <MenuButton
              entries={moreEntries}
              menuLabel="その他"
              className="cb-btn cb-btn-iconly"
              title="その他"
              ariaLabel="その他"
              buttonRef={moreBtnRef}
              onOpen={() => {
                setSortOpen(false);
                setPickerOpen(false);
                if (actionsInMenu) refreshLibraryRoot();
              }}
              width={MORE_MENU_WIDTH}
            >
              <Icon name="more" size={16} />
            </MenuButton>
            <span className="cb-tb-divider" aria-hidden />
            <button
              type="button"
              className={"cb-btn cb-btn-iconly" + (rightRailVisible ? " on" : "")}
              onClick={toggleRightRail}
              aria-pressed={rightRailVisible}
              title={
                rightRailVisible
                  ? "右ペインを隠す"
                  : `右ペインを表示${railShortcut ? ` (${railShortcut})` : ""}`
              }
              aria-label={rightRailVisible ? "右ペインを隠す" : "右ペインを表示"}
            >
              <Icon name={command("toggleRightPane").icon} size={16} />
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
