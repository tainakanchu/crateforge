import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as ripperApi from "../../api/ripper";
import { getOrganizeActive } from "../../api/library";
import { useStore } from "../../store/useStore";
import { Icon } from "../Icon";
import type {
  DiscToc,
  DuplicateHit,
  EncodeFormat,
  ReleaseCandidate,
  RipTrackAction,
} from "../../types";
import { DuplicateActionSelect, DuplicateBadge, countActions } from "../DuplicateControls";
import { defaultDecision, replaceTargetOf, type DuplicateDecision } from "../../lib/duplicates";
import { defaultDevice } from "../../lib/disc";
import { primeRipChime } from "../../lib/ripChime";

interface RipDialogProps {
  open: boolean;
  // 検出ダイアログから開いたときの検出元ドライブ。null なら保存済み/自動検出に従う。
  initialDevice?: string | null;
  onClose: () => void;
  onLibraryChanged: () => void;
}

// ドライブ選択の「その他…」(手入力) を表す番兵値
const OTHER_DEVICE = "__other__";

type Stage = "idle" | "detecting" | "looking-up" | "ready" | "ripping" | "done" | "error";

const FORMATS: { value: EncodeFormat; label: string; desc: string }[] = [
  { value: "flac", label: "FLAC", desc: "可逆圧縮" },
  { value: "alac", label: "ALAC", desc: "Apple Lossless (.m4a) — 推奨 (DJソフト互換)" },
  { value: "mp3", label: "MP3 320kbps", desc: "互換性重視" },
  { value: "wav", label: "WAV", desc: "無圧縮" },
];

export function RipDialog({ open: isOpen, initialDevice = null, onClose, onLibraryChanged: _onLibraryChanged }: RipDialogProps) {
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);
  const ripFormat = useStore((s) => s.ripFormat);
  const ripOutputDir = useStore((s) => s.ripOutputDir);
  const setRipFormat = useStore((s) => s.setRipFormat);
  const setRipOutputDir = useStore((s) => s.setRipOutputDir);
  const setRipDevice = useStore((s) => s.setRipDevice);
  const [stage, setStage] = useState<Stage>("idle");
  const [device, setDevice] = useState(
    () => useStore.getState().ripDevice ?? defaultDevice(),
  );
  // listCdDrives で検出したドライブ一覧と、「その他…」(手入力) モードか
  const [drives, setDrives] = useState<string[]>([]);
  const [customDevice, setCustomDevice] = useState(false);
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
  // 取り込み済み検出 (トラック番号 → 一致した既存曲) と、トラックごとの扱い。
  const [dupHits, setDupHits] = useState<Map<number, DuplicateHit[]>>(new Map());
  const [decisions, setDecisions] = useState<Map<number, DuplicateDecision>>(new Map());
  const [dupChecking, setDupChecking] = useState(false);
  // 開始前の「N 曲はすでにライブラリにあります」確認
  const [confirmOpen, setConfirmOpen] = useState(false);

  // リリースを選んだら、各トラックがライブラリにあるかを照合する。
  useEffect(() => {
    setDupHits(new Map());
    setDecisions(new Map());
    setConfirmOpen(false);
    if (!isOpen || !selectedRelease) return;
    let cancelled = false;
    setDupChecking(true);
    ripperApi
      .findRipDuplicates({
        album: selectedRelease.title,
        albumArtist: selectedRelease.artist,
        tracks: selectedRelease.tracks,
      })
      .then((res) => {
        if (cancelled) return;
        const hits = new Map<number, DuplicateHit[]>();
        const dec = new Map<number, DuplicateDecision>();
        for (const r of res) {
          if (r.hits.length === 0) continue;
          hits.set(r.position, r.hits);
          dec.set(r.position, defaultDecision(r.hits));
        }
        setDupHits(hits);
        setDecisions(dec);
      })
      .catch((e: unknown) => console.warn("duplicate check failed:", e))
      .finally(() => {
        if (!cancelled) setDupChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedRelease]);


  useEffect(() => {
    if (isOpen) {
      getOrganizeActive().then(setOrganizeActive).catch(() => setOrganizeActive(false));
    }
  }, [isOpen]);

  // 開くたびにドライブを検出し、初期ドライブを決める。
  // 優先順: 検出ダイアログの検出元 > 保存済み (ripDevice) > 検出した先頭 > 既定値
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCustomDevice(false);
    if (initialDevice) {
      // 新しく入れたディスクなので、前回の TOC/候補は捨てる
      setDevice(initialDevice);
      setToc(null);
      setCandidates([]);
      setSelectedRelease(null);
      setErrorMsg("");
      setStage("idle");
    } else {
      const saved = useStore.getState().ripDevice;
      if (saved) setDevice(saved);
    }
    ripperApi
      .listCdDrives()
      .catch(() => [] as string[])
      .then((list) => {
        if (cancelled) return;
        setDrives(list);
        if (!initialDevice && !useStore.getState().ripDevice) {
          setDevice(list[0] ?? defaultDevice());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, initialDevice]);

  const handleDetect = useCallback(async () => {
    setStage("detecting");
    setErrorMsg("");
    try {
      const t = await ripperApi.detectDisc(device);
      // 読み取れたドライブを次回の既定 & ディスク監視対象として覚える
      setRipDevice(device);
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
  }, [device, setRipDevice]);

  const handlePickOutputDir = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setOutputDir(dir);
      setRipOutputDir(dir);
    }
  }, [setRipOutputDir]);

  // 選択中で、取り込み済みとして見つかったトラック。
  const selectedDupPositions = useMemo(
    () => Array.from(selectedTracks).filter((n) => dupHits.has(n)),
    [selectedTracks, dupHits],
  );
  const decisionOf = useCallback(
    (n: number): DuplicateDecision =>
      decisions.get(n) ?? { action: "import", replaceTrackId: null },
    [decisions],
  );
  // 実際にリップする曲数 (スキップ指定は読まない)。
  const ripCount = useMemo(
    () => Array.from(selectedTracks).filter((n) => decisionOf(n).action !== "skip").length,
    [selectedTracks, decisionOf],
  );

  const setAllDecisions = (action: "skip" | "replace") => {
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const [n, hits] of dupHits) {
        next.set(
          n,
          action === "replace"
            ? { action, replaceTrackId: replaceTargetOf(hits) }
            : { action, replaceTrackId: null },
        );
      }
      return next;
    });
  };

  const handleRip = useCallback((confirmed = false) => {
    if (!toc || (!organizeActive && !outputDir)) {
      pushToast("info", "先に出力先フォルダを選んでください");
      return;
    }
    // 取り込み済みの曲があれば、開始前に扱いの内訳を確認する (iTunes と同様)。
    if (!confirmed && selectedDupPositions.length > 0) {
      setConfirmOpen(true);
      return;
    }
    setConfirmOpen(false);

    const sorted = Array.from(selectedTracks).sort((a, b) => a - b);
    const trackActions: RipTrackAction[] = sorted
      .map((n) => ({ n, d: decisionOf(n) }))
      .filter(({ d }) => d.action !== "import")
      .map(({ n, d }) => ({ position: n, action: d.action, replaceTrackId: d.replaceTrackId }));
    const toRip = sorted.filter((n) => decisionOf(n).action !== "skip");
    if (toRip.length === 0) {
      pushToast("info", "すべてスキップのため、リッピングする曲がありません");
      return;
    }

    const req = {
      device,
      outputDir: organizeActive ? undefined : outputDir,
      format,
      tracks: toRip,
      release: selectedRelease,
      addToLibrary: organizeActive ? true : addToLibrary,
      trackActions,
    };

    onClose(); // モーダルを即閉じ
    // 完了音のための AudioContext をユーザー操作の中で起こしておく (自動再生ポリシー対策)。
    primeRipChime();

    ripperApi.ripCd(req).catch((e: unknown) => {
      // 途中までの進捗とログは残し、どこで止まったか分かるようにする。
      // (Start 前に失敗した場合は前回分の表示を引き継がない)
      const cur = useStore.getState().ripStatus;
      const prev = cur?.phase === "ripping" ? cur : null;
      useStore.getState().setRipStatus({
        phase: "error",
        current: prev?.current ?? 0,
        total: prev?.total ?? 0,
        label: prev?.label ?? "",
        percent: prev?.percent,
        stage: prev?.stage,
        log: [...(prev?.log ?? []), String(e)],
        error: String(e),
      });
      useStore.getState().pushToast("error", `リッピング失敗: ${e}`);
    });
  }, [toc, organizeActive, outputDir, device, format, selectedTracks, selectedRelease, addToLibrary, onClose, pushToast, selectedDupPositions, decisionOf]);

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
              <Icon name="disc" size={16} /> CD を取り込む —{" "}
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
          </div>
          {ripStatus.phase !== "ripping" && (
            <div className="modal-footer">
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
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rip-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="disc" size={16} /> CD を取り込む
          </h2>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Device + detect */}
          <div className="rip-row">
            <label>ドライブ:</label>
            {drives.length > 0 && (
              <select
                value={!customDevice && drives.includes(device) ? device : OTHER_DEVICE}
                onChange={(e) => {
                  if (e.target.value === OTHER_DEVICE) {
                    setCustomDevice(true);
                  } else {
                    setCustomDevice(false);
                    setDevice(e.target.value);
                  }
                }}
                disabled={stage === "ripping"}
                className="rip-input"
                aria-label="ドライブ"
              >
                {drives.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                <option value={OTHER_DEVICE}>その他…</option>
              </select>
            )}
            {(drives.length === 0 || customDevice || !drives.includes(device)) && (
              <input
                type="text"
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                disabled={stage === "ripping"}
                className="rip-input"
                placeholder={defaultDevice()}
                aria-label="ドライブ (手入力)"
              />
            )}
            <button
              className="toolbar-btn primary"
              onClick={handleDetect}
              disabled={stage === "detecting" || stage === "looking-up" || stage === "ripping"}
            >
              {stage === "detecting" ? "TOC を読み取り中…" :
                stage === "looking-up" ? "照会中…" : "ディスクを検出"}
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
                      {c.artist || "不明なアーティスト"} — {c.title}
                      {c.date ? ` (${c.date.slice(0, 4)})` : ""}
                      {c.country ? ` [${c.country}]` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rip-note">
                  一致するリリースが見つかりません。候補を手動で切り替えない限り、ファイル名は「Track NN」になります。
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
                <span>
                  曲
                  {dupChecking && <span className="dup-checking"> ライブラリと照合中…</span>}
                  {!dupChecking && dupHits.size > 0 && (
                    <span className="dup-checking"> {dupHits.size} 曲は取り込み済み</span>
                  )}
                </span>
                <button className="rip-link" onClick={toggleAll}>
                  {selectedTracks.size === toc.trackCount ? "すべて解除" : "すべて選択"}
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
                    {dupHits.has(t.num) && (
                      <>
                        <DuplicateBadge hits={dupHits.get(t.num)!} />
                        <DuplicateActionSelect
                          hits={dupHits.get(t.num)!}
                          value={decisionOf(t.num)}
                          disabled={!selectedTracks.has(t.num)}
                          onChange={(d) => setDecisions((prev) => new Map(prev).set(t.num, d))}
                        />
                      </>
                    )}
                    <span className="rip-track-len">
                      {Math.floor(t.lengthSec / 60)}:{(t.lengthSec % 60).toString().padStart(2, "0")}
                    </span>
                  </label>
                ))}
              </div>

              {/* Format + output dir */}
              <div className="rip-row">
                <label>形式:</label>
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
                  <label>出力先:</label>
                  <input
                    type="text"
                    className="rip-input"
                    value={outputDir}
                    placeholder="フォルダを選択…"
                    onChange={(e) => setOutputDir(e.target.value)}
                  />
                  <button className="toolbar-btn" onClick={handlePickOutputDir}>
                    <Icon name="folderOpen" size={14} /> 選択…
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
                    &nbsp;取り込んだ曲をライブラリに追加
                  </label>
                </div>
              )}

            </>
          )}

        </div>
        {toc && stage !== "ripping" && stage !== "done" && (
          <div className="modal-footer">
            <button className="toolbar-btn" onClick={onClose}>キャンセル</button>
            <button
              className="toolbar-btn primary"
              onClick={() => handleRip()}
              disabled={ripCount === 0 || (!organizeActive && !outputDir)}
            >
              <Icon name="play" size={14} fill="currentColor" stroke={0} /> 取り込み開始（
              {ripCount} 曲）
            </button>
          </div>
        )}
        {confirmOpen && (
          <RipDuplicatesConfirm
            count={selectedDupPositions.length}
            counts={countActions(selectedDupPositions.map(decisionOf))}
            onSkipAll={() => setAllDecisions("skip")}
            onReplaceAll={() => setAllDecisions("replace")}
            onCancel={() => setConfirmOpen(false)}
            onProceed={() => handleRip(true)}
          />
        )}
      </div>
    </div>
  );
}


/** 開始前の「N 曲はすでにライブラリにあります」確認 (iTunes の取り込み済み確認相当)。 */
function RipDuplicatesConfirm({
  count,
  counts,
  onSkipAll,
  onReplaceAll,
  onCancel,
  onProceed,
}: {
  count: number;
  counts: { import: number; skip: number; replace: number };
  onSkipAll: () => void;
  onReplaceAll: () => void;
  onCancel: () => void;
  onProceed: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    // RipDialog 側の Esc より先に拾って確認だけを閉じる。
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="disc" size={16} /> {count} 曲はすでにライブラリにあります
          </h2>
          <button className="modal-close" onClick={onCancel}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13 }}>
            取り込む {counts.import} 曲 / スキップ {counts.skip} 曲 / 置き換え {counts.replace} 曲
          </div>
          <div style={{ fontSize: 12, color: "var(--tx2)" }}>
            スキップした曲は読み取りません。置き換えると、既存の曲（プレイリスト・レート・再生回数・編集したタグ）は
            そのままに、ファイルだけを新しく取り込んだものに差し替えます。古いファイルは削除せず「_replaced」フォルダへ移します。
          </div>
          <div className="dup-bulk">
            <button className="rip-link" onClick={onSkipAll}>すべてスキップ</button>
            <button className="rip-link" onClick={onReplaceAll}>すべて置き換え</button>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="toolbar-btn" onClick={onCancel}>
              キャンセル
            </button>
            <button className="toolbar-btn primary" onClick={onProceed}>
              続ける
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
