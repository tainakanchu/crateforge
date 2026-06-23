import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as convertApi from "../api/convert";
import { Icon } from "./Icon";
import { useStore } from "../store/useStore";
import type { ConvertFormat, ConvertProgress } from "../types";

interface ConvertDialogProps {
  trackIds: number[];
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

export function ConvertDialog({ trackIds, onClose, onLibraryChanged }: ConvertDialogProps) {
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

  const pushToast = useStore((s) => s.pushToast);

  // 初期フォーカス用 ref（format セレクト）
  const formatSelectRef = useRef<HTMLSelectElement>(null);

  const isLossy = FORMATS.find((f) => f.value === format)?.lossy ?? false;

  // 開いた直後に format セレクトへフォーカス
  useEffect(() => {
    formatSelectRef.current?.focus();
  }, []);

  useEffect(() => {
    let un: UnlistenFn | undefined;
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
        un = u;
      });
    return () => {
      if (un) un();
    };
  }, [onLibraryChanged]);

  const pickFolder = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  }, []);

  const handleConvert = useCallback(async () => {
    if (!outputDir || running || trackIds.length === 0) return;
    try {
      await convertApi.convertTracks({
        trackIds,
        format,
        bitrateKbps: isLossy ? bitrate : null,
        outputDir,
        addToLibrary,
      });
    } catch (e) {
      pushToast("error", `変換に失敗しました: ${e}`);
    }
  }, [outputDir, running, trackIds, format, isLossy, bitrate, addToLibrary, pushToast]);

  // Esc で閉じる / Enter で変換開始（handleConvert 定義後に登録）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) {
        onClose();
      }
      // Enter で変換開始（IME 変換中・変換済み・outputDir 未設定は除外）
      if (e.key === "Enter" && !e.isComposing && !running && outputDir) {
        e.preventDefault();
        handleConvert();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [running, onClose, outputDir, handleConvert]);

  return (
    <div className="modal-overlay" onClick={running ? undefined : onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="settings" size={16} /> Convert {trackIds.length} track
            {trackIds.length === 1 ? "" : "s"}
          </h2>
          <button className="modal-close" onClick={onClose} disabled={running}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 96, color: "var(--mut)" }}>Format</span>
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
          </label>

          {isLossy && (
            <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 96, color: "var(--mut)" }}>Bitrate</span>
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

          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 96, color: "var(--mut)" }}>Output</span>
            <input
              className="rip-input"
              type="text"
              readOnly
              value={outputDir}
              placeholder="出力先フォルダを選択…"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="toolbar-btn" onClick={pickFolder} disabled={running} style={{ flexShrink: 0 }}>
              <Icon name="folderPlus" size={14} /> Browse
            </button>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={addToLibrary}
              onChange={(e) => setAddToLibrary(e.target.checked)}
              disabled={running}
            />
            <span>変換後のファイルをライブラリに追加</span>
          </label>

          {isLossy && (
            <div style={{ fontSize: 12, color: "var(--mut)" }}>
              ※ 非可逆→非可逆（m4a→mp3 など）は二重圧縮で音質が劣化します。
            </div>
          )}

          {(running || done || prog) && (
            <div className="rip-log" style={{ maxHeight: 120 }}>
              {done ? (
                <>
                  完了: {done.converted} 変換
                  {done.failed > 0 ? ` / ${done.failed} 失敗` : ""}
                  {done.added > 0 ? ` / ${done.added} 追加` : ""}
                </>
              ) : prog ? (
                <>
                  変換中 {prog.done}/{prog.total}
                  {lastName ? ` — ${lastName}` : ""}
                </>
              ) : null}
            </div>
          )}

          <div className="rip-actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="toolbar-btn" onClick={onClose} disabled={running}>
              {done ? "Close" : "Cancel"}
            </button>
            <button
              className="toolbar-btn primary"
              onClick={handleConvert}
              disabled={running || !outputDir}
            >
              {running ? "Converting…" : "Convert"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
