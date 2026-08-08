// Gig Readiness + Snapshot (#122)

import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import * as analysisApi from "../api/analysis";
import * as playlistsApi from "../api/playlists";
import { runGigReadiness } from "../lib/gigReadiness";
import {
  buildGigSnapshot,
  defaultSnapshotName,
  deleteGigSnapshot,
  loadGigSnapshots,
  saveGigSnapshot,
} from "../lib/gigSnapshot";
import type { GigCheckItem, GigReadinessResult, GigSnapshot } from "../types/gig";
import type { Track } from "../types";
import { Icon } from "./Icon";

type SourceMode = "crate" | "playlist";
type DialogTab = "check" | "snapshots";

interface GigReadinessDialogProps {
  onClose: () => void;
  /** Open Sync / Prepare dialog (App-level). */
  onOpenSync?: () => void;
  /** Open Settings for auto-export path. */
  onOpenSettings?: () => void;
}

function statusLabel(status: GigReadinessResult["status"]): {
  text: string;
  emoji: string;
  cls: string;
} {
  if (status === "ready") {
    return { text: "Ready", emoji: "✅", cls: "ready" };
  }
  if (status === "warning") {
    return { text: "Needs attention", emoji: "⚠️", cls: "warning" };
  }
  return { text: "Not ready", emoji: "❌", cls: "blocker" };
}

function severityIcon(sev: GigCheckItem["severity"]): string {
  if (sev === "blocker") return "xCircle";
  if (sev === "warning") return "warning";
  return "checkCircle";
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  }
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function GigReadinessDialog({
  onClose,
  onOpenSync,
  onOpenSettings,
}: GigReadinessDialogProps) {
  const {
    crate,
    tracks,
    analysisByTrack,
    setMeta,
    crateAnchors,
    autoExportEnabled,
    autoExportPath,
    selectedPlaylistId,
    playlists,
    pushToast,
  } = useStore();

  const selectedPlaylist = useMemo(
    () =>
      selectedPlaylistId != null
        ? playlists.find((p) => p.playlistId === selectedPlaylistId) ?? null
        : null,
    [playlists, selectedPlaylistId],
  );

  const [source, setSource] = useState<SourceMode>(() =>
    crate.length > 0 ? "crate" : selectedPlaylistId != null ? "playlist" : "crate",
  );
  const [tab, setTab] = useState<DialogTab>("check");
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([]);
  const [loadingPl, setLoadingPl] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [snapshots, setSnapshots] = useState<GigSnapshot[]>(() => loadGigSnapshots());
  const [viewSnapshot, setViewSnapshot] = useState<GigSnapshot | null>(null);
  const [savingName, setSavingName] = useState<string | null>(null);

  // Load playlist tracks when source = playlist
  useEffect(() => {
    if (source !== "playlist" || selectedPlaylistId == null) {
      setPlaylistTracks([]);
      return;
    }
    let cancelled = false;
    setLoadingPl(true);
    playlistsApi
      .getPlaylistTracks(selectedPlaylistId, 1_000_000)
      .then((list) => {
        if (!cancelled) setPlaylistTracks(list);
      })
      .catch((err) => {
        console.error("Failed to load playlist for gig readiness:", err);
        if (!cancelled) {
          setPlaylistTracks([]);
          pushToast("error", `プレイリスト読み込み失敗: ${err}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPl(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, selectedPlaylistId, pushToast]);

  const activeTracks: Track[] =
    source === "crate" ? crate : playlistTracks;

  const sourceName =
    source === "crate"
      ? setMeta.title.trim() || "Staging Crate"
      : selectedPlaylist?.name || "Playlist";

  const result = useMemo(() => {
    if (source === "playlist" && loadingPl) {
      return null;
    }
    return runGigReadiness({
      tracks: activeTracks,
      analysisByTrack,
      setMeta: source === "crate" ? setMeta : null,
      anchors: source === "crate" ? crateAnchors : {},
      autoExportEnabled,
      autoExportPath,
      includeLint: source === "crate",
    });
  }, [
    source,
    loadingPl,
    activeTracks,
    analysisByTrack,
    setMeta,
    crateAnchors,
    autoExportEnabled,
    autoExportPath,
  ]);

  // Reset expanded when source/result changes
  useEffect(() => {
    setExpanded(new Set());
  }, [source, result?.status, result?.items.length]);

  const trackName = useCallback(
    (id: number): string => {
      const t =
        activeTracks.find((x) => x.trackId === id) ??
        tracks.find((x) => x.trackId === id);
      if (!t) return `#${id}`;
      const name = t.name || `#${id}`;
      return t.artist ? `${name} — ${t.artist}` : name;
    },
    [activeTracks, tracks],
  );

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAnalyze = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return;
      setAnalyzing(true);
      try {
        await analysisApi.analyzeTracks(ids);
        pushToast("info", `${ids.length} 曲を解析キューに投入しました`);
      } catch (err) {
        pushToast("error", `解析の開始に失敗: ${err}`);
      } finally {
        setAnalyzing(false);
      }
    },
    [pushToast],
  );

  const handleAction = useCallback(
    (item: GigCheckItem) => {
      switch (item.action) {
        case "analyze":
          void handleAnalyze(item.trackIds ?? []);
          break;
        case "show-missing":
          if (item.trackIds?.length) {
            setExpanded((prev) => new Set(prev).add(item.id));
          }
          break;
        case "open-sync":
          if (onOpenSync) {
            onOpenSync();
            onClose();
          } else {
            pushToast(
              "info",
              "ツールバーの Sync / 同期 から Prepare for Gig を開けます",
            );
          }
          break;
        case "open-export":
          if (onOpenSettings) {
            onOpenSettings();
            onClose();
          } else {
            pushToast("info", "設定 → 一般 で自動エクスポート先を指定できます");
          }
          break;
        case "dismiss-lint":
          // Expand for visibility; dismiss is local to set tools
          setExpanded((prev) => new Set(prev).add(item.id));
          break;
        default:
          break;
      }
    },
    [handleAnalyze, onOpenSync, onOpenSettings, onClose, pushToast],
  );

  const handlePrepare = useCallback(() => {
    if (onOpenSync) {
      pushToast("info", "同期 / Prepare ダイアログを開きます");
      onOpenSync();
      onClose();
    } else {
      pushToast(
        "info",
        "ツールバーの Sync からデバイス同期・Prepare for Gig を実行できます",
      );
    }
  }, [onOpenSync, onClose, pushToast]);

  const openSavePrompt = useCallback(() => {
    setSavingName(defaultSnapshotName(sourceName));
  }, [sourceName]);

  const commitSave = useCallback(() => {
    if (savingName == null) return;
    const snap = buildGigSnapshot({
      name: savingName,
      source,
      sourceName,
      playlistId: source === "playlist" ? selectedPlaylistId : null,
      tracks: activeTracks,
      analysisByTrack,
      setMeta: source === "crate" ? setMeta : null,
    });
    const next = saveGigSnapshot(snap);
    setSnapshots(next);
    setSavingName(null);
    pushToast("success", `Snapshot「${snap.name}」を保存しました`);
    setTab("snapshots");
    setViewSnapshot(snap);
  }, [
    savingName,
    source,
    sourceName,
    selectedPlaylistId,
    activeTracks,
    analysisByTrack,
    setMeta,
    pushToast,
  ]);

  const handleDeleteSnapshot = useCallback(
    (id: string) => {
      if (!window.confirm("この Snapshot を削除しますか？")) return;
      const next = deleteGigSnapshot(id);
      setSnapshots(next);
      if (viewSnapshot?.id === id) setViewSnapshot(null);
      pushToast("info", "Snapshot を削除しました");
    },
    [viewSnapshot, pushToast],
  );

  const badge = result ? statusLabel(result.status) : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal gig-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="gig-readiness-title"
      >
        <div className="modal-header">
          <h2 id="gig-readiness-title">
            <Icon name="checkCircle" size={18} />
            Gig Readiness
          </h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            title="閉じる"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="gig-tabs">
          <button
            type="button"
            className={"gig-tab" + (tab === "check" ? " on" : "")}
            onClick={() => {
              setTab("check");
              setViewSnapshot(null);
            }}
          >
            Check
          </button>
          <button
            type="button"
            className={"gig-tab" + (tab === "snapshots" ? " on" : "")}
            onClick={() => setTab("snapshots")}
          >
            Snapshots
            {snapshots.length > 0 && (
              <span className="gig-tab-count">{snapshots.length}</span>
            )}
          </button>
        </div>

        <div className="modal-body gig-body">
          {tab === "check" && (
            <>
              <div className="gig-source-row">
                <span className="gig-source-label">Source</span>
                <div className="gig-source-seg">
                  <button
                    type="button"
                    className={"gig-seg-btn" + (source === "crate" ? " on" : "")}
                    onClick={() => setSource("crate")}
                  >
                    Staging Crate
                    <span className="gig-seg-meta">{crate.length}</span>
                  </button>
                  <button
                    type="button"
                    className={
                      "gig-seg-btn" + (source === "playlist" ? " on" : "")
                    }
                    onClick={() => setSource("playlist")}
                    disabled={selectedPlaylistId == null}
                    title={
                      selectedPlaylistId == null
                        ? "プレイリストを選択してください"
                        : selectedPlaylist?.name ?? "Playlist"
                    }
                  >
                    Current Playlist
                    {selectedPlaylistId != null && (
                      <span className="gig-seg-meta">
                        {loadingPl && source === "playlist"
                          ? "…"
                          : playlistTracks.length || "—"}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {source === "playlist" && selectedPlaylistId == null && (
                <div className="gig-empty-hint">
                  サイドバーでプレイリストを選択すると、その内容をチェックできます。
                </div>
              )}

              {loadingPl && source === "playlist" ? (
                <div className="gig-loading">プレイリストを読み込み中…</div>
              ) : (
                result &&
                badge && (
                  <>
                    <div className={"gig-status-badge " + badge.cls}>
                      <span className="gig-status-emoji" aria-hidden>
                        {badge.emoji}
                      </span>
                      <div className="gig-status-text">
                        <strong>{badge.text}</strong>
                        <span>
                          {sourceName} · {result.summary.total} tracks ·{" "}
                          {fmtDuration(result.summary.durationMs)}
                          {result.summary.missing > 0 &&
                            ` · missing ${result.summary.missing}`}
                          {result.summary.unanalyzed > 0 &&
                            ` · unanalyzed ${result.summary.unanalyzed}`}
                        </span>
                      </div>
                    </div>

                    <ul className="gig-check-list">
                      {result.items.map((item) => {
                        const open = expanded.has(item.id);
                        const hasTracks =
                          item.trackIds != null && item.trackIds.length > 0;
                        return (
                          <li
                            key={item.id}
                            className={"gig-check-item sev-" + item.severity}
                          >
                            <div className="gig-check-main">
                              <Icon
                                name={severityIcon(item.severity)}
                                size={15}
                              />
                              <div className="gig-check-copy">
                                <div className="gig-check-title">
                                  {item.title}
                                </div>
                                <div className="gig-check-detail">
                                  {item.detail}
                                </div>
                              </div>
                              <div className="gig-check-actions">
                                {hasTracks && (
                                  <button
                                    type="button"
                                    className="gig-mini-btn"
                                    onClick={() => toggleExpand(item.id)}
                                    title={open ? "曲一覧を閉じる" : "曲一覧"}
                                  >
                                    {open ? "Hide" : `${item.trackIds!.length} tracks`}
                                  </button>
                                )}
                                {item.action === "analyze" && (
                                  <button
                                    type="button"
                                    className="gig-mini-btn primary"
                                    disabled={analyzing}
                                    onClick={() => handleAction(item)}
                                  >
                                    Analyze
                                  </button>
                                )}
                                {item.action === "show-missing" && hasTracks && (
                                  <button
                                    type="button"
                                    className="gig-mini-btn"
                                    onClick={() => handleAction(item)}
                                  >
                                    Show
                                  </button>
                                )}
                                {item.action === "open-export" && (
                                  <button
                                    type="button"
                                    className="gig-mini-btn"
                                    onClick={() => handleAction(item)}
                                  >
                                    Settings
                                  </button>
                                )}
                              </div>
                            </div>
                            {open && hasTracks && (
                              <ul className="gig-track-drill">
                                {item.trackIds!.slice(0, 40).map((id) => (
                                  <li key={id}>{trackName(id)}</li>
                                ))}
                                {item.trackIds!.length > 40 && (
                                  <li className="gig-track-more">
                                    +{item.trackIds!.length - 40} more
                                  </li>
                                )}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )
              )}
            </>
          )}

          {tab === "snapshots" && (
            <div className="gig-snapshots">
              {viewSnapshot ? (
                <div className="gig-snap-detail">
                  <button
                    type="button"
                    className="gig-mini-btn"
                    onClick={() => setViewSnapshot(null)}
                  >
                    ← Back
                  </button>
                  <h3 className="gig-snap-name">{viewSnapshot.name}</h3>
                  <dl className="gig-snap-dl">
                    <div>
                      <dt>Saved</dt>
                      <dd>{fmtDate(viewSnapshot.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>
                        {viewSnapshot.source === "crate"
                          ? "Staging Crate"
                          : "Playlist"}{" "}
                        · {viewSnapshot.sourceName}
                      </dd>
                    </div>
                    <div>
                      <dt>Tracks</dt>
                      <dd>{viewSnapshot.summary.total}</dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>{fmtDuration(viewSnapshot.summary.durationMs)}</dd>
                    </div>
                    <div>
                      <dt>Missing @ save</dt>
                      <dd>{viewSnapshot.summary.missing}</dd>
                    </div>
                    <div>
                      <dt>Unanalyzed @ save</dt>
                      <dd>{viewSnapshot.summary.unanalyzed}</dd>
                    </div>
                    {viewSnapshot.setMeta?.targetDurationMin != null && (
                      <div>
                        <dt>Target</dt>
                        <dd>{viewSnapshot.setMeta.targetDurationMin} min</dd>
                      </div>
                    )}
                  </dl>
                  {viewSnapshot.setMeta?.notes && (
                    <p className="gig-snap-notes">{viewSnapshot.setMeta.notes}</p>
                  )}
                  <div className="gig-snap-detail-actions">
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={() => handleDeleteSnapshot(viewSnapshot.id)}
                    >
                      <Icon name="trash" size={14} />
                      Delete
                    </button>
                  </div>
                </div>
              ) : snapshots.length === 0 ? (
                <div className="gig-empty-hint">
                  まだ Snapshot がありません。Check タブから「Save Snapshot」で現在の状態を保存できます。
                </div>
              ) : (
                <ul className="gig-snap-list">
                  {snapshots.map((s) => (
                    <li key={s.id} className="gig-snap-row">
                      <button
                        type="button"
                        className="gig-snap-row-main"
                        onClick={() => setViewSnapshot(s)}
                      >
                        <span className="gig-snap-row-name">{s.name}</span>
                        <span className="gig-snap-row-meta">
                          {fmtDate(s.createdAt)} · {s.summary.total} tracks
                          {s.summary.missing > 0 &&
                            ` · missing ${s.summary.missing}`}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="cb-cx"
                        title="削除"
                        onClick={() => handleDeleteSnapshot(s.id)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {tab === "check" && (
          <div className="gig-footer">
            {savingName != null ? (
              <div className="gig-save-row">
                <input
                  className="gig-save-input"
                  value={savingName}
                  onChange={(e) => setSavingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitSave();
                    if (e.key === "Escape") setSavingName(null);
                  }}
                  autoFocus
                  aria-label="Snapshot name"
                />
                <button
                  type="button"
                  className="toolbar-btn primary"
                  onClick={commitSave}
                  disabled={!savingName.trim() || activeTracks.length === 0}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => setSavingName(null)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={openSavePrompt}
                  disabled={activeTracks.length === 0 || loadingPl}
                  title="現在の状態を Snapshot として保存"
                >
                  <Icon name="save" size={14} />
                  Save Snapshot
                </button>
                <button
                  type="button"
                  className="toolbar-btn primary"
                  onClick={handlePrepare}
                >
                  <Icon name="upload" size={14} />
                  Prepare for Gig…
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
