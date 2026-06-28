import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as ripperApi from "../../api/ripper";
import { getOrganizeActive } from "../../api/library";
import { useStore } from "../../store/useStore";
import { Icon } from "../Icon";
import type {
  DiscToc,
  EncodeFormat,
  ReleaseCandidate,
} from "../../types";
import { defaultDevice } from "../../lib/disc";

interface RipDialogProps {
  open: boolean;
  onClose: () => void;
  onLibraryChanged: () => void;
}

type Stage = "idle" | "detecting" | "looking-up" | "ready" | "ripping" | "done" | "error";

const FORMATS: { value: EncodeFormat; label: string; desc: string }[] = [
  { value: "flac", label: "FLAC", desc: "可逆圧縮" },
  { value: "alac", label: "ALAC", desc: "Apple Lossless (.m4a) — 推奨 (DJソフト互換)" },
  { value: "mp3", label: "MP3 320kbps", desc: "互換性重視" },
  { value: "wav", label: "WAV", desc: "無圧縮" },
];

export function RipDialog({ open: isOpen, onClose, onLibraryChanged: _onLibraryChanged }: RipDialogProps) {
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);
  const ripFormat = useStore((s) => s.ripFormat);
  const ripOutputDir = useStore((s) => s.ripOutputDir);
  const setRipFormat = useStore((s) => s.setRipFormat);
  const setRipOutputDir = useStore((s) => s.setRipOutputDir);
  const [stage, setStage] = useState<Stage>("idle");
  const [device, setDevice] = useState(defaultDevice());
  const [toc, setToc] = useState<DiscToc | null>(null);
  const [candidates, setCandidates] = useState<ReleaseCandidate[]>([]);
  const [selectedRelease, setSelectedRelease] = useState<ReleaseCandidate | null>(null);
  const [organizeActive, setOrganizeActive] = useState(false);
  const [format, setFormat] = useState<EncodeFormat>(ripFormat);
  const [outputDir, setOutputDir] = useState(ripOutputDir ?? "");
  const [selectedTracks, setSelectedTracks] = useState<Set<number>>(new Set());
  const [addToLibrary, setAddToLibrary] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const ripStatus = useStore((s) => s.ripStatus);


  useEffect(() => {
    if (isOpen) {
      getOrganizeActive().then(setOrganizeActive).catch(() => setOrganizeActive(false));
    }
  }, [isOpen]);

  const handleDetect = useCallback(async () => {
    setStage("detecting");
    setErrorMsg("");
    try {
      const t = await ripperApi.detectDisc(device);
      setToc(t);
      setSelectedTracks(new Set(Array.from({ length: t.trackCount }, (_, i) => i + 1)));
      setStage("looking-up");
      // MusicBrainz lookup
      let releases: ReleaseCandidate[] = [];
      if (t.musicbrainzId) {
        try {
          releases = await ripperApi.lookupReleaseByDiscId(t.musicbrainzId);
        } catch (e) {
          console.warn("disc-id lookup failed:", e);
        }
      }
      setCandidates(releases);
      if (releases.length > 0) {
        setSelectedRelease(releases[0]);
      }
      setStage("ready");
    } catch (e) {
      setErrorMsg(`${e}`);
      setStage("error");
    }
  }, [device]);

  const handlePickOutputDir = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setOutputDir(dir);
      setRipOutputDir(dir);
    }
  }, [setRipOutputDir]);

  const handleRip = useCallback(() => {
    if (!toc || (!organizeActive && !outputDir)) {
      pushToast("info", "先に出力先フォルダを選んでください");
      return;
    }

    const req = {
      device,
      outputDir: organizeActive ? undefined : outputDir,
      format,
      tracks: Array.from(selectedTracks).sort((a, b) => a - b),
      release: selectedRelease,
      addToLibrary: organizeActive ? true : addToLibrary,
    };

    onClose(); // モーダルを即閉じ

    ripperApi.ripCd(req).catch((e: unknown) => {
      useStore.getState().setRipStatus({
        phase: "error",
        current: 0,
        total: 0,
        label: "",
        log: [String(e)],
        error: String(e),
      });
      useStore.getState().pushToast("error", `リッピング失敗: ${e}`);
    });
  }, [toc, organizeActive, outputDir, device, format, selectedTracks, selectedRelease, addToLibrary, onClose, pushToast]);

  const trackList = useMemo(() => {
    if (!toc) return [];
    return Array.from({ length: toc.trackCount }, (_, i) => {
      const num = i + 1;
      const relTrack = selectedRelease?.tracks.find((t) => t.position === num);
      const lenSec = toc.trackLengthsSec[i] ?? 0;
      return {
        num,
        title: relTrack?.title ?? `Track ${num.toString().padStart(2, "0")}`,
        artist: relTrack?.artist ?? "",
        lengthSec: lenSec,
      };
    });
  }, [toc, selectedRelease]);

  const toggleTrack = (n: number) => {
    setSelectedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  const toggleAll = () => {
    if (!toc) return;
    if (selectedTracks.size === toc.trackCount) {
      setSelectedTracks(new Set());
    } else {
      setSelectedTracks(new Set(Array.from({ length: toc.trackCount }, (_, i) => i + 1)));
    }
  };

  if (!isOpen) return null;

  // リップ中/完了/エラーのログビューモード
  if (ripStatus) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal rip-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>
              <Icon name="disc" size={16} /> Rip CD —{" "}
              {ripStatus.phase === "ripping"
                ? "リッピング中"
                : ripStatus.phase === "done"
                  ? "完了"
                  : "エラー"}
            </h2>
            <button className="modal-close" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="modal-body">
            <pre className="rip-log">{ripStatus.log.join("\n")}</pre>
            {ripStatus.phase !== "ripping" && (
              <div className="rip-actions">
                <button
                  className="toolbar-btn primary"
                  onClick={() => {
                    useStore.getState().clearRipStatus();
                    onClose();
                  }}
                >
                  閉じる
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rip-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="disc" size={16} /> Rip CD
          </h2>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Device + detect */}
          <div className="rip-row">
            <label>Drive:</label>
            <input
              type="text"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              disabled={stage === "ripping"}
              className="rip-input"
            />
            <button
              className="toolbar-btn primary"
              onClick={handleDetect}
              disabled={stage === "detecting" || stage === "looking-up" || stage === "ripping"}
            >
              {stage === "detecting" ? "Reading TOC..." :
                stage === "looking-up" ? "Looking up..." : "Detect Disc"}
            </button>
          </div>

          {errorMsg && (
            <div className="rip-error">⚠ {errorMsg}</div>
          )}

          {/* Release candidates */}
          {toc && stage !== "ripping" && stage !== "done" && (
            <>
              <div className="rip-section-title">
                MusicBrainz {candidates.length > 0 ? `(${candidates.length} candidate${candidates.length > 1 ? "s" : ""})` : "(no match — Unknown CD)"}
              </div>
              {candidates.length > 0 ? (
                <select
                  className="rip-select"
                  value={selectedRelease?.releaseId ?? ""}
                  onChange={(e) => {
                    const r = candidates.find((c) => c.releaseId === e.target.value);
                    setSelectedRelease(r ?? null);
                  }}
                >
                  {candidates.map((c) => (
                    <option key={c.releaseId} value={c.releaseId}>
                      {c.artist} — {c.title}
                      {c.date ? ` (${c.date.slice(0, 4)})` : ""}
                      {c.country ? ` [${c.country}]` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rip-note">
                  No matching release. Files will be named "Track NN" unless you switch candidates manually.
                  <br />
                  Disc ID: <code>{toc.musicbrainzId}</code>
                </div>
              )}

              {selectedRelease?.coverArtUrl && (
                <img
                  className="rip-cover"
                  src={selectedRelease.coverArtUrl}
                  alt="cover"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                />
              )}

              {/* Track list */}
              <div className="rip-section-title">
                Tracks
                <button className="rip-link" onClick={toggleAll}>
                  {selectedTracks.size === toc.trackCount ? "Deselect all" : "Select all"}
                </button>
              </div>
              <div className="rip-track-list">
                {trackList.map((t) => (
                  <label key={t.num} className="rip-track-row">
                    <input
                      type="checkbox"
                      checked={selectedTracks.has(t.num)}
                      onChange={() => toggleTrack(t.num)}
                    />
                    <span className="rip-track-num">{t.num.toString().padStart(2, "0")}</span>
                    <span className="rip-track-title">
                      {t.title}
                      {t.artist ? <span className="rip-track-artist"> — {t.artist}</span> : null}
                    </span>
                    <span className="rip-track-len">
                      {Math.floor(t.lengthSec / 60)}:{(t.lengthSec % 60).toString().padStart(2, "0")}
                    </span>
                  </label>
                ))}
              </div>

              {/* Format + output dir */}
              <div className="rip-row">
                <label>Format:</label>
                <select
                  className="rip-select"
                  value={format}
                  onChange={(e) => {
                    const f = e.target.value as EncodeFormat;
                    setFormat(f);
                    setRipFormat(f);
                  }}
                >
                  {FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label} — {f.desc}
                    </option>
                  ))}
                </select>
              </div>
              {!organizeActive && (
                <div className="rip-row">
                  <label>Output:</label>
                  <input
                    type="text"
                    className="rip-input"
                    value={outputDir}
                    placeholder="Select folder..."
                    onChange={(e) => setOutputDir(e.target.value)}
                  />
                  <button className="toolbar-btn" onClick={handlePickOutputDir}>
                    <Icon name="folderOpen" size={14} /> Browse
                  </button>
                </div>
              )}
              {!organizeActive && (
                <div className="rip-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={addToLibrary}
                      onChange={(e) => setAddToLibrary(e.target.checked)}
                    />
                    &nbsp;Add ripped tracks to library
                  </label>
                </div>
              )}

              <div className="rip-actions">
                <button className="toolbar-btn" onClick={onClose}>Cancel</button>
                <button
                  className="toolbar-btn primary"
                  onClick={handleRip}
                  disabled={selectedTracks.size === 0 || (!organizeActive && !outputDir)}
                >
                  <Icon name="play" size={14} fill="currentColor" stroke={0} /> Start Ripping (
                  {selectedTracks.size})
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}

