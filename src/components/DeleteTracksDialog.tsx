import { useCallback, useEffect, useMemo, useState } from "react";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { useEscapeKey } from "../hooks/useEscapeKey";

interface DeleteTracksDialogProps {
  /**
   * 削除対象の曲の ID。確認に出す件数・先頭の数曲・ルート外のファイル数はバックエンドが数えるので、
   * 対象の曲を読み込まずに何曲でも (全選択の数万曲でも) 渡せる。
   */
  trackIds: number[];
  /** キャンセル / 完了でモーダルを閉じる */
  onClose: () => void;
  /** 削除が成功したときに呼ばれる（一覧の再読み込み用） */
  onDeleted: () => void;
}

export function DeleteTracksDialog({ trackIds: rawIds, onClose, onDeleted }: DeleteTracksDialogProps) {
  // 同じ曲を 2 回含むプレイリストから選ぶと同じ trackId が重複して渡る。
  // 削除 API 引数がずれないよう一意化する。
  const ids = useMemo(() => [...new Set(rawIds)], [rawIds]);
  const pushToast = useStore((s) => s.pushToast);
  const removeFromCrate = useStore((s) => s.removeFromCrate);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [rootLoaded, setRootLoaded] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);

  // 確認に出す内容 (件数・先頭の数曲・ルート外のファイル数)。届くまでは件数を ID の数で仮に出す。
  const [preview, setPreview] = useState<libraryApi.DeleteTracksPreview | null>(null);

  // 整理ルートは「ファイルも削除する」を許可してよいかの判定に使う。
  // organize が無効なら Rust 側も削除を拒否するので、UI でも出さない。
  useEffect(() => {
    let alive = true;
    (async () => {
      let root: string | null = null;
      try {
        const [r, active] = await Promise.all([
          libraryApi.getLibraryRoot(),
          libraryApi.getOrganizeActive(),
        ]);
        root = active && r ? r : null;
      } catch {
        root = null;
      }
      if (!alive) return;
      setLibraryRoot(root);
      try {
        const p = await libraryApi.previewDeleteTracks(ids, root);
        if (alive) setPreview(p);
      } catch (err) {
        // 集計できなくても削除はできる (ファイルの削除は安全側で選べないままにする)。
        console.error("Failed to preview delete:", err);
      } finally {
        if (alive) setRootLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ids]);

  // ルート外のファイルが 1 つでもあると、Rust 側は 1 件も消さずに失敗する。
  // そのためチェックボックス自体を無効にし、理由を添えて出す。
  const outsideCount = preview?.outsideRoot ?? 0;
  const canDeleteFiles = rootLoaded && !!libraryRoot && preview !== null && outsideCount === 0;

  // 条件が崩れた（ルート未設定・ルート外を含む）ときにチェックが残らないようにする。
  useEffect(() => {
    if (!canDeleteFiles) setDeleteFiles(false);
  }, [canDeleteFiles]);

  const handleDelete = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
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
  }, [busy, ids, deleteFiles, canDeleteFiles, removeFromCrate, pushToast, onDeleted, onClose]);

  // Esc で閉じる (処理中は無視)。
  useEscapeKey(onClose, { enabled: !busy });

  const total = preview?.count ?? ids.length;
  const sample = preview?.sample ?? [];

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
            {total === 1 && sample.length === 1
              ? `『${sample[0].name || "(unknown)"}』をライブラリから削除します。`
              : `${total.toLocaleString()} 曲をライブラリから削除します。`}
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
            {sample.map((t) => (
              <li key={t.trackId} className="ell">
                {t.name || "(unknown)"}
                {t.artist ? ` — ${t.artist}` : ""}
              </li>
            ))}
            {preview !== null && total > sample.length && (
              <li>ほか {(total - sample.length).toLocaleString()} 曲</li>
            )}
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
          {rootLoaded && libraryRoot && outsideCount > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--mut)" }}>
              ライブラリルート（{libraryRoot}）の外にあるファイルが {outsideCount.toLocaleString()}{" "}
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
