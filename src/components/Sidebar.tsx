import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import * as playlistsApi from "../api/playlists";
import { Icon } from "./Icon";
import appIcon from "../assets/app-icon.png";
import type { Playlist, ViewMode } from "../types";

interface SidebarProps {
  onPlaylistsChanged: () => void;
  onEditSmart: (playlistId: number | null, name?: string) => void;
}

/** サイドバー右クリック用メニューの状態（位置＋対象プレイリスト） */
interface SidebarMenuState {
  x: number;
  y: number;
  pl: Playlist;
}

interface SidebarMenuAction {
  id: string;
  icon: string;
  label: string;
  /** 破壊的操作（赤字表示用） */
  danger?: boolean;
  run: () => void;
}

/** TrackContextMenu に倣った、キーボード完結のサイドバー用コンテキストメニュー */
function SidebarContextMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: SidebarMenuAction[];
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const activate = useCallback(
    (i: number) => {
      const a = actions[i];
      if (!a) return;
      a.run();
      onClose();
    },
    [actions, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // メニュー表示中は App.tsx のグローバルショートカットへ渡さない
      e.stopPropagation();
      const len = actions.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % len);
          return;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + len) % len);
          return;
        case "Enter":
        case " ":
          e.preventDefault();
          activate(activeIndex);
          return;
        case "Escape":
          e.preventDefault();
          onClose();
          return;
      }
    },
    [actions.length, activeIndex, activate, onClose],
  );

  // 開いたらメニューへフォーカス（キーボード操作を即受け付ける）
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // 画面外にはみ出さないよう位置を補正
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - r.width - 8);
    }
    if (top + r.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - r.height - 8);
    }
    setPos({ left, top });
  }, [x, y]);

  return (
    <div
      ref={containerRef}
      className="context-menu"
      style={{ top: pos.top, left: pos.left }}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      {actions.map((a, i) => (
        <div
          key={a.id}
          className={"context-menu-item" + (activeIndex === i ? " active" : "")}
          data-active={activeIndex === i || undefined}
          onMouseEnter={() => setActiveIndex(i)}
          onClick={() => activate(i)}
        >
          <Icon name={a.icon} size={14} />
          <span style={a.danger ? { color: "#f4736b" } : undefined}>{a.label}</span>
        </div>
      ))}
    </div>
  );
}

interface NavItem {
  mode: Exclude<ViewMode, "playlist">;
  icon: string;
  label: string;
}

const NAV: NavItem[] = [
  { mode: "library", icon: "music", label: "All Tracks" },
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
    pushToast,
  } = useStore();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  // 右クリック / アプリケーションキーで開くコンテキストメニュー
  const [menu, setMenu] = useState<SidebarMenuState | null>(null);
  // 新規作成のインライン入力（プレイリスト/フォルダ）
  const [creating, setCreating] = useState<null | { isFolder: boolean }>(null);
  const [creatingName, setCreatingName] = useState("");

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

  // 新規作成はインライン入力で受け付ける（window.prompt を使わない）
  const startCreate = useCallback((isFolder: boolean) => {
    setCreating({ isFolder });
    setCreatingName("");
  }, []);

  const commitCreate = useCallback(async () => {
    if (!creating) return;
    const name = creatingName.trim();
    const isFolder = creating.isFolder;
    setCreating(null);
    if (!name) return;
    try {
      await playlistsApi.createPlaylist(name, null, isFolder);
      onPlaylistsChanged();
    } catch (err) {
      pushToast("error", `Failed to create: ${err}`);
    }
  }, [creating, creatingName, onPlaylistsChanged, pushToast]);

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
        pushToast("error", `Rename failed: ${err}`);
      }
    }
    setEditingId(null);
  }, [editingId, editingName, onPlaylistsChanged, pushToast]);

  // プレイリスト/フォルダの複製。スマートは条件ごと、通常は曲ごと複製する。
  const handleDuplicate = useCallback(
    async (pl: Playlist) => {
      if (pl.isFolder) {
        pushToast("info", "Folders can't be duplicated");
        return;
      }
      const newName = `${pl.name} copy`;
      try {
        if (pl.isSmart) {
          const criteria = await playlistsApi.getSmartCriteria(pl.playlistId);
          if (!criteria) throw new Error("no criteria");
          await playlistsApi.createSmartPlaylist(newName, criteria);
        } else {
          // limit 未指定だとバックエンドが 500 件で打ち切るため、全曲を明示的に取得する。
          const tracks = await playlistsApi.getPlaylistTracks(pl.playlistId, 1_000_000);
          const created = await playlistsApi.createPlaylist(newName, pl.parentPersistentId);
          const ids = tracks.map((t) => t.trackId);
          if (ids.length > 0) {
            await playlistsApi.addTracksToPlaylist(created.playlistId, ids);
          }
        }
        onPlaylistsChanged();
        pushToast("success", `「${pl.name}」を複製しました`);
      } catch (err) {
        pushToast("error", `複製に失敗しました: ${err}`);
      }
    },
    [onPlaylistsChanged, pushToast],
  );

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
        pushToast("success", `Deleted "${pl.name}"`);
      } catch (err) {
        pushToast("error", `Delete failed: ${err}`);
      }
    },
    [selectedPlaylistId, setSelectedPlaylistId, setViewMode, onPlaylistsChanged, pushToast],
  );

  // 対象プレイリスト/フォルダ向けのメニュー項目を組み立てる
  const buildMenuActions = useCallback(
    (pl: Playlist): SidebarMenuAction[] => {
      const editable = pl.isSmart && !pl.isFolder;
      const actions: SidebarMenuAction[] = [
        { id: "rename", icon: "edit", label: "Rename", run: () => startRename(pl) },
      ];
      if (!pl.isFolder) {
        actions.push({
          id: "duplicate",
          icon: "filePlus",
          label: "Duplicate",
          run: () => handleDuplicate(pl),
        });
      }
      if (editable) {
        actions.push({
          id: "edit",
          icon: "sliders",
          label: "Edit rules",
          run: () => onEditSmart(pl.playlistId, pl.name),
        });
      }
      actions.push({
        id: "delete",
        icon: "trash",
        label: "Delete",
        danger: true,
        run: () => handleDelete(pl),
      });
      return actions;
    },
    [startRename, handleDuplicate, onEditSmart, handleDelete],
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
          tabIndex={0}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename(pl);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (isEditing) return;
            setMenu({ x: e.clientX, y: e.clientY, pl });
          }}
          onKeyDown={(e) => {
            if (isEditing) return;
            // アプリケーションキー / Shift+F10 でメニューを開く
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: r.left + 12, y: r.bottom - 4, pl });
            }
          }}
          title={
            pl.isFolder
              ? "Click to collapse/expand, double-click to rename"
              : pl.isSmart
                ? "Smart playlist — right-click for actions (Edit rules)"
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
        {/* アプリの正規アイコン（src-tauri/icons と同じ素材）を表示する。 */}
        <img className="cb-logo-img" src={appIcon} width={24} height={24} alt="Crateforge" />
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
            onClick={() => startCreate(false)}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            className="cb-iconbtn"
            title="New folder"
            onClick={() => startCreate(true)}
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
        {creating && (
          // 新規作成のインライン入力行
          <div className="cb-prow" style={{ paddingLeft: "15px" }}>
            <Icon name={creating.isFolder ? "folder" : "music"} size={14} />
            <input
              autoFocus
              className="cb-rename"
              placeholder={creating.isFolder ? "New folder…" : "New playlist…"}
              value={creatingName}
              onChange={(e) => setCreatingName(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate();
                if (e.key === "Escape") setCreating(null);
              }}
            />
          </div>
        )}
        {rootPlaylists.length === 0 ? (
          !creating && (
            <div className="cb-side-empty">
              No playlists yet. Import a library XML or create one.
            </div>
          )
        ) : (
          rootPlaylists.map((pl) => renderPlaylist(pl, 0))
        )}
      </div>

      {menu && (
        <>
          {/* クリックアウェイ用の透明オーバーレイ */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 99 }}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <SidebarContextMenu
            x={menu.x}
            y={menu.y}
            actions={buildMenuActions(menu.pl)}
            onClose={() => setMenu(null)}
          />
        </>
      )}
    </aside>
  );
}
