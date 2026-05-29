import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { ColumnPicker } from "./ColumnPicker";
import type { LibraryStats, SortField, ViewMode } from "../types";

interface ToolbarProps {
  onLibraryChanged: () => void;
  onOpenRipDialog: () => void;
  onOpenRulesPanel: () => void;
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
];

const VIEW_TITLE: Record<ViewMode, string> = {
  library: "All Tracks",
  albums: "Albums",
  artists: "Artists",
  recent: "Recently Played",
  playlist: "Playlist",
};

export function Toolbar({ onLibraryChanged, onOpenRipDialog, onOpenRulesPanel }: ToolbarProps) {
  const {
    viewMode,
    displayMode,
    setDisplayMode,
    searchQuery,
    setSearchQuery,
    setViewMode,
    sortField,
    sortOrder,
    toggleSort,
    fields,
    coverSize,
    setCoverSize,
    selectedPlaylistId,
    playlists,
    tracks,
  } = useStore();

  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  const [status, setStatus] = useState("");
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
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

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        setSearchQuery(value);
        if (value) setViewMode("library");
      }, 120);
    },
    [setSearchQuery, setViewMode],
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setSearchQuery("");
        (e.target as HTMLInputElement).value = "";
        (e.target as HTMLInputElement).blur();
      }
    },
    [setSearchQuery],
  );

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
          extensions: ["flac", "mp3", "m4a", "wav", "aac", "ogg", "opus", "aiff", "wma"],
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
      setStatus(`Exported ${r.trackCount} tracks → ${r.outputPath}`);
    } catch (err) {
      setStatus(`Export error: ${err}`);
    } finally {
      setExporting(false);
    }
  }, []);

  // View title + subcount.
  const activePlaylist =
    viewMode === "playlist"
      ? playlists.find((p) => p.playlistId === selectedPlaylistId)
      : null;
  const title = searchQuery
    ? "Search"
    : activePlaylist
      ? activePlaylist.name
      : VIEW_TITLE[viewMode];
  const subCount = searchQuery
    ? `“${searchQuery}” · ${tracks.length.toLocaleString()}`
    : activePlaylist
      ? activePlaylist.trackCount.toLocaleString()
      : viewMode === "library" && stats
        ? stats.trackCount.toLocaleString()
        : tracks.length.toLocaleString();

  const curSort = SORT_OPTIONS.find((s) => s.field === sortField);

  return (
    <>
      <div className="cb-tb">
        <div className="cb-sbox">
          <Icon name="search" size={15} />
          <input
            id="search-input"
            type="text"
            placeholder="搜尋 / Search title, artist, album…  (/)"
            defaultValue={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
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
            Sort: {curSort?.label ?? "—"}
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
              className={"cb-btn" + (coverSize > 0 ? " on" : "")}
              onClick={() => setCoverSize(coverSize > 0 ? 0 : 20)}
              title="Toggle artwork in rows"
            >
              <Icon name="grid" size={15} /> Artwork
            </button>
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
            <Icon name="settings" size={16} />
          </button>
          <button
            className="cb-btn cb-btn-iconly"
            onClick={handleExport}
            disabled={exporting || (stats?.trackCount ?? 0) === 0}
            title="Export library to iTunes-compatible XML"
          >
            <Icon name="upload" size={16} />
          </button>
        </div>

        {pickerOpen && <ColumnPicker onClose={() => setPickerOpen(false)} />}
      </div>

      <div className="cb-subbar">
        <span className="cb-title">{title}</span>
        <span className="cb-titlesub">· {subCount}</span>
        <div className="cb-stats">
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
    </>
  );
}
