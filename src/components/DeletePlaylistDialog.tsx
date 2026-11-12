import { useCallback, useEffect, useMemo, useState } from "react";
import * as playlistsApi from "../api/playlists";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import type { Playlist } from "../types";

interface DeletePlaylistDialogProps {
  playlist: Playlist;
  /** フォルダの子孫を数えるための全プレイリスト。 */
  playlists: Playlist[];
  onClose: () => void;
  /** 削除できたとき (一覧の再読み込み・選択解除用)。withContents = 子孫ごと消したか。 */
  onDeleted: (withContents: boolean) => void;
}

/** フォルダ配下の子孫 (プレイリスト / サブフォルダ) の数。循環しても止まる。 */
function countDescendants(playlists: Playlist[], folder: Playlist): number {
  if (!folder.persistentId) return 0;
  const seen = new Set<string>([folder.persistentId]);
  const queue = [folder.persistentId];
  let n = 0;
  while (queue.length > 0) {
    const pid = queue.pop()!;
    for (const p of playlists) {
      if (p.parentPersistentId !== pid || p.playlistId === folder.playlistId) continue;
      n += 1;
      if (p.persistentId && !seen.has(p.persistentId)) {
        seen.add(p.persistentId);
        queue.push(p.persistentId);
      }
    }
  }
  return n;
}

/**
 * プレイリスト / フォルダの削除確認 (曲の削除ダイアログと同系統)。
 * フォルダは「中身を残す (1 つ上の階層へ移動)」と「中身ごと削除」を選べる。既定は残す方。
 */
export function DeletePlaylistDialog({
  playlist,
  playlists,
  onClose,
  onDeleted,
}: DeletePlaylistDialogProps) {
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const childCount = useMemo(
    () => (playlist.isFolder ? countDescendants(playlists, playlist) : 0),
    [playlist, playlists],
  );
  const [withContents, setWithContents] = useState(false);

  const handleDelete = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const all = playlist.isFolder && withContents && childCount > 0;
    try {
      await playlistsApi.deletePlaylist(playlist.playlistId, all);
      pushToast(
        "success",
        all
          ? `フォルダ「${playlist.name}」を中身 (${childCount} 件) ごと削除しました`
          : playlist.isFolder
            ? `フォルダ「${playlist.name}」を削除しました（中身は残しています）`
            : `「${playlist.name}」を削除しました`,
      );
      onDeleted(all);
      onClose();
    } catch (err) {
      pushToast("error", `削除に失敗しました: ${err}`);
      setBusy(false);
    }
  }, [busy, playlist, withContents, childCount, pushToast, onDeleted, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const kind = playlist.isFolder ? "フォルダ" : playlist.isSmart ? "スマートプレイリスト" : "プレイリスト";

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="trash" size={16} /> {kind}を削除
          </h2>
          <button className="modal-close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div
          className="modal-body"
          style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div>
            {kind}『{playlist.name}』を削除します。
          </div>
          {playlist.isFolder && childCount > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <input
                  type="radio"
                  name="folder-delete-mode"
                  checked={!withContents}
                  disabled={busy}
                  onChange={() => setWithContents(false)}
                />
                <span>
                  フォルダだけ削除し、中身は残す
                  <div style={{ fontSize: 11.5, color: "var(--mut)" }}>
                    中の {childCount} 件のプレイリスト / フォルダは 1 つ上の階層へ移動します。
                  </div>
                </span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <input
                  type="radio"
                  name="folder-delete-mode"
                  checked={withContents}
                  disabled={busy}
                  onChange={() => setWithContents(true)}
                />
                <span>
                  中身ごと削除
                  <div style={{ fontSize: 11.5, color: "var(--mut)" }}>
                    中の {childCount} 件のプレイリスト / フォルダもすべて削除します。
                  </div>
                </span>
              </label>
            </div>
          ) : null}
          <div style={{ fontSize: 12, color: "var(--mut)" }}>
            曲そのものはライブラリに残ります。この操作は取り消せません。
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4, justifyContent: "flex-end" }}>
            <button className="toolbar-btn" onClick={onClose} disabled={busy}>
              キャンセル
            </button>
            <button className="toolbar-btn danger" onClick={handleDelete} disabled={busy} autoFocus>
              <Icon name="trash" size={14} /> {busy ? "削除中…" : "削除"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
