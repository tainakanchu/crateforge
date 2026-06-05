import { useCallback, useState } from "react";
import { useStore } from "../store/useStore";
import * as playlistsApi from "../api/playlists";
import { Icon } from "./Icon";
import type { Playlist, ViewMode } from "../types";

interface SidebarProps {
  onPlaylistsChanged: () => void;
  onEditSmart: (playlistId: number | null, name?: string) => void;
}

interface NavItem {
  mode: Exclude<ViewMode, "playlist">;
  icon: string;
  label: string;
}

const NAV: NavItem[] = [
  { mode: "library", icon: "music", label: "All Tracks" },
  { mode: "albums", icon: "disc", label: "Albums" },
  { mode: "artists", icon: "mic", label: "Artists" },
  { mode: "recent", icon: "clock", label: "Recently Played" },
];

export function Sidebar({ onPlaylistsChanged, onEditSmart }: SidebarProps) {
  const {
    viewMode,
    playlists,
    selectedPlaylistId,
    setViewMode,
    setSelectedPlaylistId,
    setSearchQuery,
    collapsedFolders,
    toggleFolder,
  } = useStore();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");

  const goView = useCallback(
    (mode: Exclude<ViewMode, "playlist">) => {
      setViewMode(mode);
      setSelectedPlaylistId(null);
      setSearchQuery("");
    },
    [setViewMode, setSelectedPlaylistId, setSearchQuery],
  );

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
      const name = window.prompt(isFolder ? "New folder name:" : "New playlist name:");
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
    const isActive = viewMode === "playlist" && selectedPlaylistId === pl.playlistId;
    const isEditing = editingId === pl.playlistId;
    const isCollapsed = pl.isFolder && collapsedFolders.includes(pl.playlistId);

    return (
      <div key={pl.id}>
        <div
          className={
            "cb-prow" + (isActive ? " on" : "") + (pl.isFolder ? " fold" : "")
          }
          style={{ paddingLeft: `${15 + depth * 14}px` }}
          onClick={() =>
            pl.isFolder ? toggleFolder(pl.playlistId) : handlePlaylistClick(pl)
          }
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename(pl);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const editable = pl.isSmart && !pl.isFolder;
            const action = window.prompt(
              `"${pl.name}"\n\n[r] Rename  [d] Delete${editable ? "  [e] Edit rules" : ""}`,
              "",
            );
            if (action === "r") startRename(pl);
            else if (action === "d") handleDelete(pl);
            else if (action === "e" && editable) onEditSmart(pl.playlistId, pl.name);
          }}
          title={
            pl.isFolder
              ? "Click to collapse/expand, double-click to rename"
              : pl.isSmart
                ? "Smart playlist — right-click → [e] to edit rules"
                : "Double-click to rename, right-click for actions"
          }
        >
          {pl.isFolder && (
            <Icon
              name="chevronR"
              size={11}
              style={{
                flexShrink: 0,
                opacity: 0.7,
                transition: "transform .12s",
                transform: isCollapsed ? undefined : "rotate(90deg)",
              }}
            />
          )}
          <Icon
            name={pl.isFolder ? "folder" : pl.isSmart ? "sliders" : "music"}
            size={14}
          />
          {isEditing ? (
            <input
              autoFocus
              className="cb-rename"
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
              <span className="cb-prow-label">{pl.name}</span>
              {!pl.isFolder && !pl.isSmart && (
                <span className="ct">{pl.trackCount.toLocaleString()}</span>
              )}
            </>
          )}
        </div>
        {!isCollapsed && children.map((c) => renderPlaylist(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="cb-side">
      <div className="cb-brand">
        <div className="cb-logo">
          <Icon name="layers" size={14} />
        </div>
        <b>Crateforge</b>
      </div>

      <div className="cb-lbl">Library</div>
      {NAV.map((n) => (
        <div
          key={n.mode}
          className={"cb-nav" + (viewMode === n.mode ? " on" : "")}
          onClick={() => goView(n.mode)}
        >
          <Icon name={n.icon} size={16} />
          <span className="cb-nav-label">{n.label}</span>
        </div>
      ))}

      <div className="cb-lbl">
        <span>Playlists</span>
        <span className="cb-lbl-actions">
          <button
            className="cb-iconbtn"
            title="New playlist"
            onClick={() => handleCreatePlaylist(false)}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            className="cb-iconbtn"
            title="New folder"
            onClick={() => handleCreatePlaylist(true)}
          >
            <Icon name="folderPlus" size={14} />
          </button>
          <button
            className="cb-iconbtn"
            title="New smart playlist"
            onClick={() => onEditSmart(null)}
          >
            <Icon name="sliders" size={14} />
          </button>
        </span>
      </div>

      <div className="cb-pl">
        {rootPlaylists.length === 0 ? (
          <div className="cb-side-empty">
            No playlists yet. Import a library XML or create one.
          </div>
        ) : (
          rootPlaylists.map((pl) => renderPlaylist(pl, 0))
        )}
      </div>
    </aside>
  );
}
