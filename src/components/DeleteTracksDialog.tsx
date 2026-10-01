import { useCallback, useEffect, useMemo, useState } from "react";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import type { Track } from "../types";

interface DeleteTracksDialogProps {
  /** 削除対象の曲（曲名とファイルパスの表示・ルート判定に使う） */
  tracks: Track[];
  /** キャンセル / 完了でモーダルを閉じる */
  onClose: () => void;
  /** 削除が成功したときに呼ばれる（一覧の再読み込み用） */
  onDeleted: () => void;
}

/**
 * パスが root 配下かを文字列で判定する。
 * 実際の安全判定は Rust 側 (canonicalize + starts_with) が行うので、ここは
 * 「ファイルも削除する」を出してよいかのヒントに留める。
 * 区切りは OS 差を吸収するため `/` に寄せ、末尾に区切りを足して
 * `/Music` が `/MusicOld` に前方一致してしまうのを防ぐ。
 */
function isInsideRoot(path: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return (norm(path) + "/").startsWith(norm(root) + "/");
}

export function DeleteTracksDialog({ tracks, onClose, onDeleted }: DeleteTracksDialogProps) {
  const pushToast = useStore((s) => s.pushToast);
  const removeFromCrate = useStore((s) => s.removeFromCrate);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [rootLoaded, setRootLoaded] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);

  // 整理ルートは「ファイルも削除する」を許可してよいかの判定に使う。
  // organize が無効なら Rust 側も削除を拒否するので、UI でも出さない。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [root, active] = await Promise.all([
          libraryApi.getLibraryRoot(),
          libraryApi.getOrganizeActive(),
        ]);
        if (alive) setLibraryRoot(active && root ? root : null);
      } catch {
        if (alive) setLibraryRoot(null);
      } finally {
        if (alive) setRootLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ルート外 / パス不明の曲が 1 つでもあると、Rust 側は 1 件も消さずに失敗する。
  // そのためチェックボックス自体を無効にし、理由を添えて出す。
  const outside = useMemo(() => {
    if (!libraryRoot) return [];
    return tracks.filter(
      (t) => t.fileExists && t.locationPath && !isInsideRoot(t.locationPath, libraryRoot),
    );
  }, [tracks, libraryRoot]);

  const canDeleteFiles = rootLoaded && !!libraryRoot && outside.length === 0;

  // 条件が崩れた（ルート未設定・ルート外を含む）ときにチェックが残らないようにする。
  useEffect(() => {
    if (!canDeleteFiles) setDeleteFiles(false);
  }, [canDeleteFiles]);

  const handleDelete = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ids = tracks.map((t) => t.trackId);
      const count = await libraryApi.deleteTracks(ids, deleteFiles && canDeleteFiles);
      // クレート (フロント側の一時リスト) に残っていると再生できない曲が並ぶので外す。
      for (const id of ids) removeFromCrate(id);
      pushToast(
        "success",
        deleteFiles
          ? `${count} 曲をライブラリとファイルごと削除しました`
          : `${count} 曲をライブラリから削除しました`,
      );
      onDeleted();
      onClose();
    } catch (err) {
      pushToast("error", `削除に失敗しました: ${err}`);
      setBusy(false);
    }
  }, [busy, tracks, deleteFiles, canDeleteFiles, removeFromCrate, pushToast, onDeleted, onClose]);

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

  const preview = tracks.slice(0, 5);

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="trash" size={16} /> ライブラリから削除
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
            {tracks.length === 1
              ? `『${tracks[0].name || "(unknown)"}』をライブラリから削除します。`
              : `${tracks.length} 曲をライブラリから削除します。`}
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: "var(--mut)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {preview.map((t) => (
              <li key={t.trackId} className="ell">
                {t.name || "(unknown)"}
                {t.artist ? ` — ${t.artist}` : ""}
              </li>
            ))}
            {tracks.length > preview.length && <li>ほか {tracks.length - preview.length} 曲</li>}
          </ul>
          <div style={{ fontSize: 12, color: "var(--mut)" }}>
            プレイリストへの登録・再生履歴・解析結果も一緒に消えます。この操作は取り消せません。
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              opacity: canDeleteFiles ? 1 : 0.6,
            }}
          >
            <input
              type="checkbox"
              checked={deleteFiles}
              disabled={!canDeleteFiles || busy}
              onChange={(e) => setDeleteFiles(e.target.checked)}
            />
            <span>ファイルも削除する</span>
          </label>
          {rootLoaded && !libraryRoot && (
            <div style={{ fontSize: 11.5, color: "var(--mut)" }}>
              ライブラリルート（整理先）が未設定のため、ファイルは削除できません。設定から整理先を指定してください。
            </div>
          )}
          {rootLoaded && libraryRoot && outside.length > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--mut)" }}>
              ライブラリルート（{libraryRoot}）の外にあるファイルが {outside.length}{" "}
              件含まれるため、ファイルは削除できません。安全のためルート外のファイルには触れません。
            </div>
          )}
          {deleteFiles && (
            <div style={{ fontSize: 11.5, color: "#ef9d9d" }}>
              ゴミ箱には入らず、ファイルは完全に削除されます。
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 4, justifyContent: "flex-end" }}>
            <button className="toolbar-btn" onClick={onClose} disabled={busy}>
              キャンセル
            </button>
            <button className="toolbar-btn danger" onClick={handleDelete} disabled={busy}>
              <Icon name="trash" size={14} /> {busy ? "削除中…" : "削除"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
