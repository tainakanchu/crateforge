import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as ripperApi from "../../api/ripper";
import { Icon } from "../Icon";
import type {
  DiscToc,
  EncodeFormat,
  ReleaseCandidate,
  RipProgress,
} from "../../types";

interface RipDialogProps {
  open: boolean;
  onClose: () => void;
  onLibraryChanged: () => void;
}

type Stage = "idle" | "detecting" | "looking-up" | "ready" | "ripping" | "done" | "error";

const FORMATS: { value: EncodeFormat; label: string; desc: string }[] = [
  { value: "flac", label: "FLAC", desc: "可逆圧縮 (推奨)" },
  { value: "alac", label: "ALAC", desc: "Apple Lossless (.m4a)" },
  { value: "mp3", label: "MP3 320kbps", desc: "互換性重視" },
  { value: "wav", label: "WAV", desc: "無圧縮" },
];

function defaultDevice(): string {
  if (navigator.userAgent.includes("Win")) return "D:";
  if (navigator.userAgent.includes("Mac")) return "disk1";
  return "/dev/cdrom";
}

export function RipDialog({ open: isOpen, onClose, onLibraryChanged }: RipDialogProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [device, setDevice] = useState(defaultDevice());
  const [toc, setToc] = useState<DiscToc | null>(null);
  const [candidates, setCandidates] = useState<ReleaseCandidate[]>([]);
  const [selectedRelease, setSelectedRelease] = useState<ReleaseCandidate | null>(null);
  const [format, setFormat] = useState<EncodeFormat>("flac");
  const [outputDir, setOutputDir] = useState("");
  const [selectedTracks, setSelectedTracks] = useState<Set<number>>(new Set());
  const [addToLibrary, setAddToLibrary] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [progressLines, setProgressLines] = useState<ReactNode[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  const resetState = useCallback(() => {
    setStage("idle");
    setToc(null);
    setCandidates([]);
    setSelectedRelease(null);
    setSelectedTracks(new Set());
    setErrorMsg("");
    setProgressLines([]);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      // dialog closed → tear down listener
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

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
    if (typeof dir === "string") setOutputDir(dir);
  }, []);

  const handleRip = useCallback(async () => {
    if (!toc || !outputDir) {
      alert("Pick an output directory first.");
      return;
    }

    setStage("ripping");
    setProgressLines([]);
    setErrorMsg("");

    // Attach progress listener before invoking rip_cd.
    try {
      unlistenRef.current = await ripperApi.onRipProgress((p: RipProgress) => {
        setProgressLines((prev) => [...prev, formatProgress(p)]);
        if (p.kind === "done") {
          onLibraryChanged();
          setStage("done");
        } else if (p.kind === "error") {
          setErrorMsg(p.message);
          setStage("error");
        }
      });

      await ripperApi.ripCd({
        device,
        outputDir,
        format,
        tracks: Array.from(selectedTracks).sort((a, b) => a - b),
        release: selectedRelease,
        addToLibrary,
      });
    } catch (e) {
      setErrorMsg(`${e}`);
      setStage("error");
    }
  }, [toc, outputDir, device, format, selectedTracks, selectedRelease, addToLibrary, onLibraryChanged]);

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
                  onChange={(e) => setFormat(e.target.value as EncodeFormat)}
                >
                  {FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label} — {f.desc}
                    </option>
                  ))}
                </select>
              </div>
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

              <div className="rip-actions">
                <button className="toolbar-btn" onClick={onClose}>Cancel</button>
                <button
                  className="toolbar-btn primary"
                  onClick={handleRip}
                  disabled={selectedTracks.size === 0 || !outputDir}
                >
                  <Icon name="play" size={14} fill="currentColor" stroke={0} /> Start Ripping (
                  {selectedTracks.size})
                </button>
              </div>
            </>
          )}

          {/* Ripping progress */}
          {(stage === "ripping" || stage === "done") && (
            <>
              <div className="rip-section-title">Progress</div>
              <pre className="rip-log">
                {progressLines.map((line, i) => (
                  <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>{line}{"\n"}</span>
                ))}
              </pre>
              {stage === "done" && (
                <div className="rip-actions">
                  <button className="toolbar-btn primary" onClick={() => { resetState(); onClose(); }}>Close</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatProgress(p: RipProgress): ReactNode {
  switch (p.kind) {
    case "start":
      return <><Icon name="play" size={12} fill="currentColor" stroke={0} /> Starting ({p.total} tracks)</>;
    case "trackStart":
      return `  [${p.index + 1}/${p.total}] ripping: ${p.label}`;
    case "trackProgress":
      return `      ${p.percent}%`;
    case "trackDone":
      return <>{"      "}<Icon name="check" size={12} /> {"→"} {p.outputPath}</>;
    case "done":
      return <><Icon name="checkCircle" size={12} /> Done. {p.writtenFiles.length} file(s), {p.addedTracks} added to library.</>;
    case "error":
      return <><Icon name="xCircle" size={12} /> {p.message}</>;
  }
}
