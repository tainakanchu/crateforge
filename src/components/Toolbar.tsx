import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { ColumnPicker } from "./ColumnPicker";
import type { LibraryStats, SortField, ViewMode } from "../types";
import { AUDIO_EXTENSIONS } from "../lib/audioExtensions";

interface ToolbarProps {
  onLibraryChanged: () => void;
  onOpenRipDialog: () => void;
  onOpenRulesPanel: () => void;
  onOpenSettings: () => void;
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

const VIEW_TITLE: Record<ViewMode, string> = {
  library: "All Tracks",
  albums: "Albums",
  artists: "Artists",
  recent: "Recently Played",
  playlist: "Playlist",
};

export function Toolbar({ onLibraryChanged, onOpenRipDialog, onOpenRulesPanel, onOpenSettings }: ToolbarProps) {
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
  const [status, setStatus] = useState("");
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  // 検索ボックス: 表示用ローカル state（即時反映）。store への反映はデバウンス。
  const [localSearch, setLocalSearch] = useState(searchQuery);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isListLike = viewMode !== "albums" && viewMode !== "artists";

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

  const curSort = SORT_OPTIONS.find((s) => s.field === sortField);

  return (
    <>
      <div className="cb-tb">
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
            className={"cb-segb" + (displayMode === "covers" ? " on" : "")}
            onClick={() => setDisplayMode("covers")}
            title="Covers view"
          >
            <Icon name="grid" size={14} /> Covers
          </button>
        </div>

        <div style={{ position: "relative" }}>
          <button
            className={"cb-btn" + (sortOpen ? " on" : "")}
            onClick={() => {
              setSortOpen((v) => !v);
              setPickerOpen(false);
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
              <div className="cb-sortpop" style={{ right: 0 }}>
                {SORT_OPTIONS.map((s) => {
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
          <button
            className="cb-btn cb-btn-iconly primary"
            onClick={handleImport}
            disabled={importing}
            title="Import an existing iTunes Library.xml"
          >
            <Icon name="download" size={16} />
          </button>
          <button
            className="cb-btn cb-btn-iconly"
            onClick={handleImportFiles}
            disabled={importingFiles}
            title="Add audio files to the library"
          >
            <Icon name="filePlus" size={16} />
          </button>
          <button
            className="cb-btn cb-btn-iconly"
            onClick={onOpenRipDialog}
            title="Rip an audio CD"
          >
            <Icon name="disc" size={16} />
          </button>
          <button
            className="cb-btn cb-btn-iconly"
            onClick={onOpenRulesPanel}
            title="Build playlists from YAML rules"
          >
            <Icon name="layers" size={16} />
          </button>
          <button
            className={"cb-btn cb-btn-iconly" + (libraryRoot ? " on" : "")}
            onClick={handleSetLibraryRoot}
            title={
              libraryRoot
                ? `整理先 (編集時に自動でフォルダ分け): ${libraryRoot}\nクリックで変更`
                : "整理先フォルダを設定 (未設定だと自動整理オフ)"
            }
          >
            <Icon name="folderPlus" size={16} />
          </button>
          <button
            className="cb-btn cb-btn-iconly"
            onClick={handleExport}
            disabled={exporting || (stats?.trackCount ?? 0) === 0}
            title="Export library to iTunes-compatible XML"
          >
            <Icon name="upload" size={16} />
          </button>
          <button
            className={"cb-btn cb-btn-iconly" + (autoExportEnabled ? " on" : "")}
            onClick={handleToggleAutoExport}
            title={
              autoExportEnabled
                ? `自動 XML エクスポート: ON\n${autoExportPath ?? ""}\n(変更時に約30分間隔＋終了時に自動書き出し)\nクリックで OFF`
                : "iTunes 互換 XML を自動エクスポート (変更時のみ・約30分間隔＋終了時)"
            }
          >
            <Icon name="clock" size={16} />
          </button>
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
            className="cb-btn cb-btn-iconly"
            onClick={onOpenSettings}
            title="設定"
          >
            <Icon name="settings" size={16} />
          </button>
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
