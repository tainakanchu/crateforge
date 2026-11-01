import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as playlistsApi from "../api/playlists";
import { Icon } from "./Icon";
import type { SmartRestoreEntry, SmartRestoreReport } from "../types";

interface SmartRestoreDialogProps {
  onClose: () => void;
  /// 復元で条件が変わったとき (プレイリスト一覧・表示中の曲を読み直す)。
  onRestored: () => void;
}

const STATUS_LABEL: Record<SmartRestoreEntry["status"], string> = {
  converted: "変換",
  skippedExisting: "スキップ (条件あり)",
  failed: "失敗",
  folderIgnored: "フォルダ (無視)",
};

/// iTunes XML のスマートプレイリスト条件を、取り込み済みのプレイリストへ復元するダイアログ。
/// 曲・プレイリスト自体は取り込まない (Persistent ID が一致する既存プレイリストにだけ条件を付ける)。
export function SmartRestoreDialog({ onClose, onRestored }: SmartRestoreDialogProps) {
  const [paths, setPaths] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<SmartRestoreReport | null>(null);

  const addFiles = useCallback(async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "iTunes Library XML", extensions: ["xml"] }],
    });
    if (!selected) return;
    const picked = Array.isArray(selected) ? selected : [selected];
    setPaths((cur) => [...cur, ...picked.filter((p) => !cur.includes(p))]);
  }, []);

  const handleRestore = useCallback(async () => {
    if (paths.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const r = await playlistsApi.restoreItunesSmartPlaylists(paths, overwrite);
      setReport(r);
      if (r.converted > 0 || r.groupingBackfilled > 0) onRestored();
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [paths, overwrite, onRestored]);

  // Esc で閉じる (処理中は無視)。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  const failed = report?.playlists.filter((p) => p.status === "failed") ?? [];
  const withWarnings =
    report?.playlists.filter((p) => p.status !== "failed" && p.warnings.length > 0) ?? [];

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="modal"
        style={{ width: 640, maxWidth: "calc(100vw - 32px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <Icon name="sliders" size={16} /> iTunes XML からスマートプレイリストを復元
          </h2>
          <button className="modal-close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div
          className="modal-body"
          style={{
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            fontSize: 13,
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          <div style={{ color: "var(--tx2)", lineHeight: 1.6 }}>
            iTunes の Library.xml に残っているスマートプレイリストの条件を、取り込み済みの同じ
            プレイリスト (Persistent ID が一致するもの) に設定し直します。曲やプレイリストは取り込みません。
            <br />
            古いライブラリの XML も一緒に選ぶと、条件中の古い ID を名前で解決できます
            (同じ ID は先頭のファイルを優先)。曲の Grouping が空なら XML の値で埋めます。
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {paths.map((p, i) => (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--mut)", width: 18, textAlign: "right" }}>{i + 1}.</span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--mono)",
                  }}
                  title={p}
                >
                  {p}
                </span>
                <button
                  className="toolbar-btn"
                  title="一覧から外す"
                  onClick={() => setPaths((cur) => cur.filter((x) => x !== p))}
                  disabled={busy}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
            <button
              className="toolbar-btn"
              onClick={addFiles}
              disabled={busy}
              style={{ alignSelf: "flex-start" }}
            >
              <Icon name="plus" size={14} /> XML ファイルを追加…
            </button>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              disabled={busy}
            />
            既に条件があるプレイリストも上書きする
          </label>

          {error && <div className="rip-error">{error}</div>}

          {report && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontWeight: 600 }}>
                変換 {report.converted} 件 / スキップ {report.skippedExisting} 件 / 失敗{" "}
                {report.failed} 件
                {report.foldersIgnored > 0 && ` / フォルダ ${report.foldersIgnored} 件 (無視)`}
                {report.noMatchingPlaylist > 0 &&
                  ` / 対応するプレイリストなし ${report.noMatchingPlaylist} 件`}
                {report.groupingBackfilled > 0 && ` / Grouping を ${report.groupingBackfilled} 曲に設定`}
              </div>

              {report.unresolvedRefs.length > 0 && (
                <ResultSection title={`見つからない参照 (${report.unresolvedRefs.length})`} warn>
                  {report.unresolvedRefs.map((u) => (
                    <li key={`${u.playlistName}-${u.persistentId}`}>
                      {u.playlistName} → {u.refName ? `「${u.refName}」` : ""}
                      <code>{u.persistentId}</code>
                    </li>
                  ))}
                  <li style={{ listStyle: "none", color: "var(--mut)" }}>
                    参照先が見つからない条件は「どの曲も含まない」として扱われます。
                    古いライブラリの XML を追加するか、編集画面で参照先を選び直してください。
                  </li>
                </ResultSection>
              )}

              {failed.length > 0 && (
                <ResultSection title={`失敗 (${failed.length})`} warn>
                  {failed.map((p) => (
                    <li key={p.persistentId}>
                      {p.name}: {p.message}
                      {p.warnings.length > 0 && (
                        <ul>
                          {p.warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ResultSection>
              )}

              {withWarnings.length > 0 && (
                <ResultSection title={`警告 (${withWarnings.length})`}>
                  {withWarnings.map((p) => (
                    <li key={p.persistentId}>
                      {p.name}
                      <ul>
                        {p.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ResultSection>
              )}

              {report.playlists.length > 0 && (
                <ResultSection title={`プレイリスト (${report.playlists.length})`}>
                  {report.playlists.map((p) => (
                    <li key={p.persistentId}>
                      <span style={{ color: p.status === "failed" ? "var(--warn)" : undefined }}>
                        [{STATUS_LABEL[p.status]}]
                      </span>{" "}
                      {p.name}
                    </li>
                  ))}
                </ResultSection>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="toolbar-btn" onClick={onClose} disabled={busy}>
            {report ? "閉じる" : "キャンセル"}
          </button>
          <button
            className="toolbar-btn primary"
            onClick={handleRestore}
            disabled={busy || paths.length === 0}
          >
            {busy ? "復元中…" : "復元"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultSection({
  title,
  warn,
  children,
}: {
  title: string;
  warn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ fontWeight: 600, color: warn ? "var(--warn)" : undefined }}>{title}</div>
      <ul style={{ margin: "4px 0 0", paddingLeft: 20, lineHeight: 1.6 }}>{children}</ul>
    </div>
  );
}
