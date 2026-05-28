import { useCallback, useState } from "react";
import { useStore } from "../store/useStore";
import * as playlistsApi from "../api/playlists";
import type { Playlist } from "../types";

interface SidebarProps {
  onPlaylistsChanged: () => void;
}

export function Sidebar({ onPlaylistsChanged }: SidebarProps) {
  const {
    viewMode,
    playlists,
    selectedPlaylistId,
    setViewMode,
    setSelectedPlaylistId,
    setSearchQuery,
  } = useStore();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");

  const handleLibraryClick = useCallback(() => {
    setViewMode("library");
    setSelectedPlaylistId(null);
    setSearchQuery("");
  }, [setViewMode, setSelectedPlaylistId, setSearchQuery]);

  const handleRecentClick = useCallback(() => {
    setViewMode("recent");
    setSelectedPlaylistId(null);
    setSearchQuery("");
  }, [setViewMode, setSelectedPlaylistId, setSearchQuery]);

  const handlePlaylistClick = useCallback(
    (pl: Playlist) => {
      if (pl.isFolder) return;
      setViewMode("playlist");
      setSelectedPlaylistId(pl.playlistId);
      setSearchQuery("");
    },
    [setViewMode, setSelectedPlaylistId, setSearchQuery],
  );

  const handleCreatePlaylist = useCallback(
    async (isFolder: boolean) => {
      const name = window.prompt(
        isFolder ? "New folder name:" : "New playlist name:",
      );
      if (!name?.trim()) return;
      try {
        await playlistsApi.createPlaylist(name.trim(), null, isFolder);
        onPlaylistsChanged();
      } catch (err) {
        alert(`Failed to create: ${err}`);
      }
    },
    [onPlaylistsChanged],
  );

  const startRename = useCallback((pl: Playlist) => {
    setEditingId(pl.playlistId);
    setEditingName(pl.name);
  }, []);

  const commitRename = useCallback(async () => {
    if (editingId === null) return;
    const name = editingName.trim();
    if (name) {
      try {
        await playlistsApi.renamePlaylist(editingId, name);
        onPlaylistsChanged();
      } catch (err) {
        alert(`Rename failed: ${err}`);
      }
    }
    setEditingId(null);
  }, [editingId, editingName, onPlaylistsChanged]);

  const handleDelete = useCallback(
    async (pl: Playlist) => {
      if (!confirm(`Delete "${pl.name}"?`)) return;
      try {
        await playlistsApi.deletePlaylist(pl.playlistId);
        if (selectedPlaylistId === pl.playlistId) {
          setSelectedPlaylistId(null);
          setViewMode("library");
        }
        onPlaylistsChanged();
      } catch (err) {
        alert(`Delete failed: ${err}`);
      }
    },
    [selectedPlaylistId, setSelectedPlaylistId, setViewMode, onPlaylistsChanged],
  );

  const rootPlaylists = playlists.filter((p) => !p.parentPersistentId);
  const childrenOf = (parentId: string | null) =>
    playlists.filter((p) => p.parentPersistentId === parentId);

  const renderPlaylist = (pl: Playlist, depth: number): React.ReactNode => {
    const children = childrenOf(pl.persistentId);
    const isActive =
      viewMode === "playlist" && selectedPlaylistId === pl.playlistId;
    const isEditing = editingId === pl.playlistId;

    return (
      <div key={pl.id}>
        <div
          className={`sidebar-item ${isActive ? "active" : ""} ${pl.isFolder ? "folder" : ""}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => handlePlaylistClick(pl)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename(pl);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const action = window.prompt(
              `"${pl.name}"\n\n[r] Rename  [d] Delete`,
              "",
            );
            if (action === "r") startRename(pl);
            else if (action === "d") handleDelete(pl);
          }}
          title="Double-click to rename, right-click for actions"
        >
          <span className="sidebar-icon">
            {pl.isFolder ? "📁" : pl.isSmart ? "⚙️" : "🎵"}
          </span>
          {isEditing ? (
            <input
              autoFocus
              className="sidebar-rename"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="sidebar-label">{pl.name}</span>
              {!pl.isFolder && (
                <span className="sidebar-count">{pl.trackCount}</span>
              )}
            </>
          )}
        </div>
        {children.map((c) => renderPlaylist(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-title">Library</div>
        <div
          className={`sidebar-item ${viewMode === "library" ? "active" : ""}`}
          onClick={handleLibraryClick}
        >
          <span className="sidebar-icon">🎶</span>
          <span className="sidebar-label">All Tracks</span>
        </div>
        <div
          className={`sidebar-item ${viewMode === "albums" ? "active" : ""}`}
          onClick={() => {
            setViewMode("albums");
            setSelectedPlaylistId(null);
            setSearchQuery("");
          }}
        >
          <span className="sidebar-icon">💿</span>
          <span className="sidebar-label">Albums</span>
        </div>
        <div
          className={`sidebar-item ${viewMode === "artists" ? "active" : ""}`}
          onClick={() => {
            setViewMode("artists");
            setSelectedPlaylistId(null);
            setSearchQuery("");
          }}
        >
          <span className="sidebar-icon">🎤</span>
          <span className="sidebar-label">Artists</span>
        </div>
        <div
          className={`sidebar-item ${viewMode === "recent" ? "active" : ""}`}
          onClick={handleRecentClick}
        >
          <span className="sidebar-icon">🕐</span>
          <span className="sidebar-label">Recently Played</span>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>Playlists</span>
          <span className="sidebar-section-actions">
            <button
              className="sidebar-iconbtn"
              title="New playlist"
              onClick={() => handleCreatePlaylist(false)}
            >
              ＋
            </button>
            <button
              className="sidebar-iconbtn"
              title="New folder"
              onClick={() => handleCreatePlaylist(true)}
            >
              📁＋
            </button>
          </span>
        </div>
        <div className="sidebar-playlists">
          {rootPlaylists.length === 0 ? (
            <div className="sidebar-empty">
              No playlists yet. Import a library XML or create one.
            </div>
          ) : (
            rootPlaylists.map((pl) => renderPlaylist(pl, 0))
          )}
        </div>
      </div>
    </div>
  );
}
