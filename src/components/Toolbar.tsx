import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { ColumnPicker } from "./ColumnPicker";
import type { LibraryStats, SortField, ViewMode } from "../types";
import { ALBUM_SORT_FIELDS } from "../types";
import { AUDIO_EXTENSIONS } from "../lib/audioExtensions";

interface ToolbarProps {
  onLibraryChanged: () => void;
  onOpenRipDialog: () => void;
  onOpenRulesPanel: () => void;
  onOpenSyncProvision: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

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
];

// 完了 status をサブバーから自動で消すまでの時間 (#152)。
const STATUS_CLEAR_MS = 8000;

// ツールバー(行)の実効幅がこれを下回ったら、右側のアクション群を ⋯ メニューに畳む。
const COMPACT_WIDTH = 1200;
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
  artists: "Artists",
  recent: "Recently Played",
  playlist: "Playlist",
};

export function Toolbar({
  onLibraryChanged,
  onOpenRipDialog,
  onOpenRulesPanel,
  onOpenSyncProvision,
  onOpenSettings,
  onOpenHelp,
}: ToolbarProps) {
  const {
    viewMode,
    displayMode,
    setDisplayMode,
    searchQuery,
    setSearchQuery,
    filterTags,
    removeFilterTag,
    clearFilterTags,
    setViewMode,
    sortField,
    sortOrder,
    toggleSort,
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
  const [exporting, setExporting] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
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
    const isError = /error|失敗/i.test(text);
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
  // 幅が足りないときだけアクション群を ⋯ に畳む。
  const [compact, setCompact] = useState(false);
  // 検索ボックス: 表示用ローカル state（即時反映）。store への反映はデバウンス。
  const [localSearch, setLocalSearch] = useState(searchQuery);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const isListLike = viewMode !== "artists";

  // ツールバー幅を監視して compact を切り替える（初回描画前に確定させたいので layout effect）。
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    setCompact(el.clientWidth < COMPACT_WIDTH);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setCompact(e.contentRect.width < COMPACT_WIDTH);
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

  useEffect(() => {
    refreshStats();
  }, [refreshStats, tracks.length]);

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
      // store 反映はデバウンス。ただし1文字のときはタイマー自体セットしない（空文字クリアは通す）。
      clearTimeout(searchTimer.current);
      if (value.length === 1) return;
      searchTimer.current = setTimeout(() => {
        setSearchQuery(value);
        if (value) setViewMode("library");
      }, 300);
    },
    [setSearchQuery, setViewMode],
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
    setStatus("Importing…");
    try {
      const r = await libraryApi.importLibrary(path as string);
      setStatus(
        `Imported ${r.trackCount} tracks, ${r.playlistCount} playlists` +
          (r.missingFiles > 0 ? ` (${r.missingFiles} missing)` : ""),
      );
      onLibraryChanged();
      refreshStats();
    } catch (err) {
      setStatus(`Import error: ${err}`);
    } finally {
      setImporting(false);
    }
  }, [onLibraryChanged, refreshStats]);

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
    setStatus(`Importing ${paths.length} file(s)…`);
    try {
      const r = await libraryApi.importFiles(paths as string[]);
      setStatus(
        `Imported ${r.addedTracks} file(s)` + (r.skipped > 0 ? `, skipped ${r.skipped}` : ""),
      );
      if (r.addedTracks > 0) {
        useStore
          .getState()
          .pushToast(
            "success",
            `${r.addedTracks} 曲を取り込みました — Inbox に追加されました。サイドバーの Inbox から整理できます`,
            5200,
          );
      }
      onLibraryChanged();
      refreshStats();
    } catch (err) {
      setStatus(`Import files error: ${err}`);
    } finally {
      setImportingFiles(false);
    }
  }, [onLibraryChanged, refreshStats]);

  const handleExport = useCallback(async () => {
    const path = await save({
      filters: [{ name: "iTunes Library XML", extensions: ["xml"] }],
      defaultPath: "iTunes Library.xml",
    });
    if (!path) return;
    setExporting(true);
    setStatus("Exporting…");
    try {
      const r = await libraryApi.exportLibrary(path);
      // 自動エクスポートの出力先として記憶する。
      setAutoExport(autoExportEnabled, path);
      setStatus(`Exported ${r.trackCount} tracks → ${r.outputPath}`);
    } catch (err) {
      setStatus(`Export error: ${err}`);
    } finally {
      setExporting(false);
    }
  }, [autoExportEnabled, setAutoExport]);

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
  const title = isSearching
    ? "Search"
    : activePlaylist
      ? activePlaylist.name
      : VIEW_TITLE[viewMode];
  const subCount = isSearching
    ? tracks.length.toLocaleString()
    : activePlaylist
      ? activePlaylist.trackCount.toLocaleString()
      : viewMode === "library" && stats
        ? stats.trackCount.toLocaleString()
        : tracks.length.toLocaleString();

  // Albums モードはアルバム粒度のソートのみ (ALBUM_SORT_FIELDS の順序を維持)。
  const albumSortOptions = ALBUM_SORT_FIELDS.map(
    (f) => SORT_OPTIONS.find((o) => o.field === f)!,
  );
  const sortOptions = displayMode === "albums" ? albumSortOptions : SORT_OPTIONS;
  const curSort = sortOptions.find((s) => s.field === sortField);

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
      id: "import",
      label: "Import XML",
      icon: "download",
      title: "Import an existing iTunes Library.xml",
      onClick: handleImport,
      disabled: importing,
      primary: true,
    },
    {
      id: "importFiles",
      label: "Add Files",
      icon: "filePlus",
      title: "Add audio files to the library",
      onClick: handleImportFiles,
      disabled: importingFiles,
    },
    {
      id: "rip",
      label: "Rip CD",
      icon: "disc",
      title: "Rip an audio CD",
      onClick: onOpenRipDialog,
    },
    {
      id: "rules",
      label: "Rules",
      icon: "layers",
      title: "Build playlists from YAML rules",
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
      label: "Export XML",
      icon: "upload",
      title: "Export library to iTunes-compatible XML",
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
  ];


  return (
    <>
      <div className="cb-tb">
        {/* 狭い幅では横スクロールさせ、どのボタンも必ず届くようにする。 */}
        <div className="cb-tb-row" ref={rowRef}>
          <div className="cb-sbox" style={{ position: "relative" }}>
            <Icon name="search" size={15} />
            <input
              id="search-input"
              ref={searchInputRef}
              type="text"
              placeholder="Search… or bpm:120-128  key:8A  energy:60-100  (/ or Ctrl+F)"
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

          <div className="cb-seg">
            <button
              className={"cb-segb" + (displayMode === "list" ? " on" : "")}
              onClick={() => setDisplayMode("list")}
              title="List view"
            >
              <Icon name="list" size={14} /> List
            </button>
            <button
              className={"cb-segb" + (displayMode === "albums" ? " on" : "")}
              onClick={() => setDisplayMode("albums")}
              title="Albums view"
            >
              <Icon name="grid" size={14} /> Albums
            </button>
            <button
              className={"cb-segb" + (displayMode === "tracks" ? " on" : "")}
              onClick={() => setDisplayMode("tracks")}
              title="Track wall"
            >
              <Icon name="disc" size={14} /> Tracks
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
              title="Sort"
            >
              {/* ソートフィールド名＋現在の昇順/降順を常時表示 */}
              Sort: {curSort?.label ?? "—"} {sortOrder === "asc" ? "↑" : "↓"}
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
                        onClick={() => toggleSort(s.field)}
                      >
                        {s.label}
                        {on && (
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
                onClick={() => {
                  setPickerOpen((v) => !v);
                  setSortOpen(false);
                  setMoreOpen(false);
                }}
                title="Customize columns"
              >
                <Icon name="sliders" size={15} /> Columns
                <span className="cb-btn-badge">{fields.length}</span>
              </button>
            </>
          )}

          <div className="cb-tb-spacer" />

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
          <span className="cb-titlesel">· {selectedTrackIds.size.toLocaleString()} selected</span>
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
                <b>{stats.trackCount.toLocaleString()}</b> tracks
              </span>
              <span>·</span>
              <span>
                <b>{stats.playlistCount}</b> playlists
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
              title={`Remove "${t}"`}
              onClick={() => removeFilterTag(t)}
            >
              {t}
              <Icon name="x" size={12} />
            </button>
          ))}
          <button className="cb-fclear" onClick={clearFilterTags}>
            clear all
          </button>
        </div>
      )}
    </>
  );
}
