import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as convertApi from "../api/convert";
import { getTracksByIds } from "../api/library";
import { Icon } from "./Icon";
import { useStore } from "../store/useStore";
import {
  countLossyToLossy,
  notableResults,
  reasonLabel,
  warningLabel,
} from "../lib/convertReplace";
import type {
  ConvertFormat,
  ConvertMode,
  ConvertProgress,
  ConvertReplaceProgress,
  ReplaceJob,
} from "../types";

interface ConvertDialogProps {
  trackIds: number[];
  /** 開いたときの方式。右クリックの「変換して置き換え…」からは "replace"。 */
  initialMode?: ConvertMode;
  onClose: () => void;
  onLibraryChanged: () => void;
}

const FORMATS: { value: ConvertFormat; label: string; lossy: boolean }[] = [
  { value: "mp3", label: "MP3", lossy: true },
  { value: "aac", label: "AAC (m4a)", lossy: true },
  { value: "opus", label: "Opus", lossy: true },
  { value: "flac", label: "FLAC", lossy: false },
  { value: "alac", label: "ALAC (m4a)", lossy: false },
  { value: "wav", label: "WAV", lossy: false },
];

const BITRATES = [320, 256, 192, 128, 96];

const LABEL_STYLE = { width: 96, color: "var(--mut)" } as const;
const ROW_STYLE = { display: "flex", alignItems: "center", gap: 10 } as const;

export function ConvertDialog({
  trackIds,
  initialMode = "export",
  onClose,
  onLibraryChanged,
}: ConvertDialogProps) {
  const [mode, setMode] = useState<ConvertMode>(initialMode);
  const [format, setFormat] = useState<ConvertFormat>("mp3");
  const [bitrate, setBitrate] = useState(320);
  const [outputDir, setOutputDir] = useState("");
  const [addToLibrary, setAddToLibrary] = useState(true);
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [lastName, setLastName] = useState("");
  const [done, setDone] = useState<{ converted: number; failed: number; added: number } | null>(
    null,
  );
  const [replaceDone, setReplaceDone] = useState<ReplaceJob | null>(null);
  const [codecs, setCodecs] = useState<(string | null)[]>([]);

  const pushToast = useStore((s) => s.pushToast);
  const original = useStore((s) => s.convertOriginal);
  const setOriginal = useStore((s) => s.setConvertOriginal);

  // 初期フォーカス用 ref（format セレクト）
  const formatSelectRef = useRef<HTMLSelectElement>(null);

  const isLossy = FORMATS.find((f) => f.value === format)?.lossy ?? false;
  const lossyToLossy = useMemo(() => countLossyToLossy(codecs, format), [codecs, format]);
  const finished = mode === "replace" ? replaceDone !== null : done !== null;
  const canStart = !running && trackIds.length > 0 && (mode === "replace" || !!outputDir);

  // 開いた直後に format セレクトへフォーカス
  useEffect(() => {
    formatSelectRef.current?.focus();
  }, []);

  // 非可逆 → 非可逆の件数を出すために元のコーデックを読む。
  useEffect(() => {
    let cancelled = false;
    getTracksByIds(trackIds)
      .then((ts) => {
        if (!cancelled) setCodecs(ts.map((t) => t.codec ?? null));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trackIds]);

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let unReplace: UnlistenFn | undefined;
    let disposed = false;
    convertApi
      .onConvertProgress((p: ConvertProgress) => {
        if (p.kind === "start") {
          setRunning(true);
          setDone(null);
          setProg({ done: 0, total: p.total });
        } else if (p.kind === "item") {
          setProg({ done: p.index, total: p.total });
          setLastName(p.name);
        } else if (p.kind === "done") {
          setRunning(false);
          setDone(p);
          if (p.added > 0) onLibraryChanged();
        }
      })
      .then((u) => {
        if (disposed) u();
        else un = u;
      });
    convertApi
      .onConvertReplaceProgress((p: ConvertReplaceProgress) => {
        if (p.kind === "start") {
          setRunning(true);
          setReplaceDone(null);
          setProg({ done: 0, total: p.total });
        } else if (p.kind === "item") {
          setProg({ done: p.index, total: p.total });
          setLastName(p.result.name ?? "");
        } else if (p.kind === "done") {
          setRunning(false);
          setReplaceDone(p.job);
          if (p.job.counts.ok > 0) onLibraryChanged();
        }
      })
      .then((u) => {
        if (disposed) u();
        else unReplace = u;
      });
    return () => {
      disposed = true;
      un?.();
      unReplace?.();
    };
  }, [onLibraryChanged]);

  const pickFolder = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  }, []);

  const handleConvert = useCallback(async () => {
    if (!canStart) return;
    setProg(null);
    try {
      if (mode === "replace") {
        setReplaceDone(null);
        setRunning(true);
        await convertApi.convertReplaceTracks({
          trackIds,
          format,
          bitrateKbps: isLossy ? bitrate : null,
          original,
        });
      } else {
        await convertApi.convertTracks({
          trackIds,
          format,
          bitrateKbps: isLossy ? bitrate : null,
          outputDir,
          addToLibrary,
        });
      }
    } catch (e) {
      setRunning(false);
      pushToast("error", `変換に失敗しました: ${e}`);
    }
  }, [canStart, mode, outputDir, trackIds, format, isLossy, bitrate, original, addToLibrary, pushToast]);

  // Esc で閉じる / Enter で変換開始（handleConvert 定義後に登録）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) {
        onClose();
      }
      // Enter で変換開始（IME 変換中・実行中・開始できない状態は除外）
      if (e.key === "Enter" && !e.isComposing && canStart) {
        e.preventDefault();
        handleConvert();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [running, onClose, canStart, handleConvert]);

  const notable = replaceDone ? notableResults(replaceDone.results) : [];

  return (
    <div className="modal-overlay" onClick={running ? undefined : onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="settings" size={16} /> {trackIds.length} 曲
            {mode === "replace" ? "を変換して置き換え" : "の形式を変換"}
          </h2>
          <button className="modal-close" onClick={onClose} disabled={running}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={ROW_STYLE}>
            <span style={LABEL_STYLE}>方式</span>
            <select
              className="rip-input"
              value={mode}
              onChange={(e) => setMode(e.target.value as ConvertMode)}
              disabled={running}
              style={{ flex: 1, minWidth: 0 }}
            >
              <option value="export">書き出し</option>
              <option value="replace">置き換え</option>
            </select>
          </label>

          <label style={ROW_STYLE}>
            <span style={LABEL_STYLE}>形式</span>
            <select
              ref={formatSelectRef}
              className="rip-input"
              value={format}
              onChange={(e) => setFormat(e.target.value as ConvertFormat)}
              disabled={running}
              style={{ flex: 1, minWidth: 0 }}
            >
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            {lossyToLossy > 0 && (
              <span
                className="dup-badge dup-broken"
                title={`${lossyToLossy} 曲は非可逆→非可逆の再圧縮（音質が劣化）`}
                style={{ flexShrink: 0 }}
              >
                <Icon name="warning" size={12} /> {lossyToLossy}
              </span>
            )}
          </label>

          {isLossy && (
            <label style={ROW_STYLE}>
              <span style={LABEL_STYLE}>ビットレート</span>
              <select
                className="rip-input"
                value={bitrate}
                onChange={(e) => setBitrate(Number(e.target.value))}
                disabled={running}
                style={{ flex: 1, minWidth: 0 }}
              >
                {BITRATES.map((b) => (
                  <option key={b} value={b}>
                    {b} kbps
                  </option>
                ))}
              </select>
            </label>
          )}

          {mode === "replace" ? (
            <label
              style={ROW_STYLE}
              title="同じ曲（レート・再生回数・プレイリスト）のままファイルだけ差し替えます"
            >
              <span style={LABEL_STYLE}>元ファイル</span>
              <select
                className="rip-input"
                value={original}
                onChange={(e) => setOriginal(e.target.value as "trash" | "replaced")}
                disabled={running}
                style={{ flex: 1, minWidth: 0 }}
              >
                <option value="trash">ゴミ箱へ</option>
                <option value="replaced">_replaced に残す</option>
              </select>
            </label>
          ) : (
            <>
              <label style={ROW_STYLE}>
                <span style={LABEL_STYLE}>出力先</span>
                <input
                  className="rip-input"
                  type="text"
                  readOnly
                  value={outputDir}
                  placeholder="フォルダを選択…"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button className="toolbar-btn" onClick={pickFolder} disabled={running} style={{ flexShrink: 0 }}>
                  <Icon name="folderPlus" size={14} /> 選択…
                </button>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={addToLibrary}
                  onChange={(e) => setAddToLibrary(e.target.checked)}
                  disabled={running}
                />
                <span>ライブラリに追加</span>
              </label>
            </>
          )}

          {(running || finished || prog) && (
            <div className="rip-log" style={{ maxHeight: 160 }}>
              {mode === "replace" && replaceDone ? (
                <ReplaceSummary job={replaceDone} notable={notable} />
              ) : mode === "export" && done ? (
                <>
                  完了: {done.converted} 変換
                  {done.failed > 0 ? ` / ${done.failed} 失敗` : ""}
                  {done.added > 0 ? ` / ${done.added} 追加` : ""}
                </>
              ) : prog ? (
                <>
                  {prog.done}/{prog.total}
                  {lastName ? ` — ${lastName}` : ""}
                </>
              ) : (
                "…"
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="toolbar-btn" onClick={onClose} disabled={running}>
            {finished ? "閉じる" : "キャンセル"}
          </button>
          <button className="toolbar-btn primary" onClick={handleConvert} disabled={!canStart}>
            {running ? "変換中…" : mode === "replace" ? "置き換え" : "変換"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 置き換えの結果: 件数と、成功以外の曲の一覧 (理由の詳細はホバー)。 */
function ReplaceSummary({
  job,
  notable,
}: {
  job: ReplaceJob;
  notable: ReplaceJob["results"];
}) {
  const { ok, skipped, failed } = job.counts;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <span title="置き換え">
          <Icon name="check" size={12} /> {ok}
        </span>
        <span title="スキップ">
          <Icon name="next" size={12} /> {skipped}
        </span>
        <span title="失敗">
          <Icon name="x" size={12} /> {failed}
        </span>
      </div>
      {job.error && <div title={job.error}>✕ {job.error}</div>}
      {notable.length > 0 && (
        <details>
          <summary>詳細</summary>
          {notable.map((r) => (
            <div
              key={r.trackId}
              title={[r.message, r.oldLocationPath].filter(Boolean).join("\n")}
              style={{ display: "flex", gap: 8 }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name ?? `#${r.trackId}`}
              </span>
              <span style={{ color: "var(--mut)", flexShrink: 0 }}>
                {r.status === "ok"
                  ? r.warnings.map(warningLabel).join(", ")
                  : reasonLabel(r.reason)}
              </span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
