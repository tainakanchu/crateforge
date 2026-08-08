// Set History (#123) — list + detail for real gig performance history.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useStore } from "../store/useStore";
import * as libraryApi from "../api/library";
import { loadGigSnapshots, getGigSnapshot } from "../lib/gigSnapshot";
import {
  appendSetHistoryTracks,
  comparePlannedVsPlayed,
  createSetHistory,
  defaultHistoryName,
  deleteSetHistory,
  listSetHistories,
  removeSetHistoryTrack,
  removeSetHistoryUnresolved,
  reorderSetHistoryTrack,
  resolveSetHistoryUnresolved,
  updateSetHistoryMeta,
} from "../lib/setHistoryStore";
import { parseSetHistoryFile } from "../lib/setHistoryParse";
import { matchImportItemsAgainstLibrary } from "../lib/setHistoryMatch";
import type { SetHistoryEntry, SetHistorySource } from "../types/setHistory";
import type { Track } from "../types";
import type { GigSnapshot } from "../types/gig";

const SOURCE_LABEL: Record<SetHistorySource, string> = {
  manual: "Manual",
  m3u: "M3U",
  csv: "CSV",
  crateforge: "Crateforge",
  other: "Other",
};

function fmtDate(iso: string): string {
  try {
    // date-only
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (hh === "00" && mm === "00" && iso.length <= 10) return `${y}-${m}-${day}`;
    return `${y}-${m}-${day} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

function performedAtInputValue(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return iso.slice(0, 10);
  }
}

export function SetHistoryView() {
  const pushToast = useStore((s) => s.pushToast);
  const selectedTrackIds = useStore((s) => s.selectedTrackIds);
  const libraryTracks = useStore((s) => s.tracks);
  const clearCrate = useStore((s) => s.clearCrate);
  const restoreCrateTracks = useStore((s) => s.restoreCrateTracks);
  const setRailTab = useStore((s) => s.setRailTab);
  const setRightRailVisible = useStore((s) => s.setRightRailVisible);

  const [entries, setEntries] = useState<SetHistoryEntry[]>(() => listSetHistories());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTracks, setDetailTracks] = useState<Track[]>([]);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [importing, setImporting] = useState(false);
  const [bindQuery, setBindQuery] = useState("");
  const [bindResults, setBindResults] = useState<Track[]>([]);
  const [bindForIndex, setBindForIndex] = useState<number | null>(null);
  const [bindSearching, setBindSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const snapshots = useMemo(() => loadGigSnapshots(), [selectedId, entries]);

  const refresh = useCallback(() => {
    setEntries(listSetHistories());
  }, []);

  // Load resolved tracks for detail
  useEffect(() => {
    if (!selected || selected.trackIds.length === 0) {
      setDetailTracks([]);
      return;
    }
    let cancelled = false;
    setLoadingTracks(true);
    libraryApi
      .getTracksByIds(selected.trackIds)
      .then((ts) => {
        if (cancelled) return;
        // preserve history order
        const byId = new Map(ts.map((t) => [t.trackId, t]));
        const ordered: Track[] = [];
        for (const id of selected.trackIds) {
          const t = byId.get(id);
          if (t) ordered.push(t);
        }
        setDetailTracks(ordered);
      })
      .catch((err) => {
        console.error("Failed to load set history tracks:", err);
        if (!cancelled) setDetailTracks([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingTracks(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.trackIds.join(",")]);

  const linkedSnapshot: GigSnapshot | null = useMemo(() => {
    if (!selected?.linkedSnapshotId) return null;
    return getGigSnapshot(selected.linkedSnapshotId);
  }, [selected?.linkedSnapshotId, snapshots]);

  const plannedVsPlayed = useMemo(() => {
    if (!selected || !linkedSnapshot) return null;
    return comparePlannedVsPlayed(linkedSnapshot.trackIds, selected.trackIds);
  }, [selected, linkedSnapshot]);

  const handleNewManual = useCallback(() => {
    const name = window.prompt("セット名", defaultHistoryName());
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const entry = createSetHistory({
      name: trimmed,
      source: "manual",
      performedAt: new Date().toISOString().slice(0, 10),
    });
    refresh();
    setSelectedId(entry.id);
    pushToast("success", `「${entry.name}」を作成しました`);
  }, [refresh, pushToast]);

  const handleImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const text = await file.text();
        const parsed = parseSetHistoryFile(file.name, text);
        if (parsed.items.length === 0) {
          pushToast("error", "ファイルから曲を読み取れませんでした");
          return;
        }
        const match = await matchImportItemsAgainstLibrary(parsed.items);
        const entry = createSetHistory({
          name: parsed.suggestedName,
          source: parsed.source,
          performedAt: new Date().toISOString().slice(0, 10),
          trackIds: match.trackIds,
          persistentIds: match.persistentIds,
          unresolved: match.unresolved,
        });
        refresh();
        setSelectedId(entry.id);
        pushToast(
          "success",
          `${match.resolvedCount} 曲を紐付け、${match.unresolvedCount} 曲は未解決`,
        );
      } catch (err) {
        console.error("Set history import failed:", err);
        pushToast("error", `インポート失敗: ${err}`);
      } finally {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [refresh, pushToast],
  );

  const handleDelete = useCallback(() => {
    if (!selected) return;
    if (!window.confirm(`「${selected.name}」を削除しますか？`)) return;
    deleteSetHistory(selected.id);
    setSelectedId(null);
    refresh();
    pushToast("info", "履歴を削除しました");
  }, [selected, refresh, pushToast]);

  const patchMeta = useCallback(
    (patch: Parameters<typeof updateSetHistoryMeta>[1]) => {
      if (!selected) return;
      updateSetHistoryMeta(selected.id, patch);
      refresh();
    },
    [selected, refresh],
  );

  const handleRemoveTrack = useCallback(
    (trackId: number) => {
      if (!selected) return;
      removeSetHistoryTrack(selected.id, trackId);
      refresh();
    },
    [selected, refresh],
  );

  const handleMoveTrack = useCallback(
    (from: number, dir: -1 | 1) => {
      if (!selected) return;
      const to = from + dir;
      if (to < 0 || to >= selected.trackIds.length) return;
      reorderSetHistoryTrack(selected.id, from, to);
      refresh();
    },
    [selected, refresh],
  );

  const handleAddSelected = useCallback(() => {
    if (!selected) return;
    const ids = Array.from(selectedTrackIds);
    if (ids.length === 0) {
      pushToast("info", "ライブラリで曲を選択してから追加してください");
      return;
    }
    // Prefer currently loaded library tracks; fall back to API
    const fromLib = libraryTracks.filter((t) => selectedTrackIds.has(t.trackId));
    const needIds = ids.filter((id) => !fromLib.some((t) => t.trackId === id));
    const finish = (extra: Track[]) => {
      const all = [...fromLib, ...extra];
      // preserve selection iteration order of ids
      const byId = new Map(all.map((t) => [t.trackId, t]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((t): t is Track => !!t);
      appendSetHistoryTracks(
        selected.id,
        ordered.map((t) => ({
          trackId: t.trackId,
          persistentId: t.persistentId,
        })),
      );
      refresh();
      pushToast("success", `${ordered.length} 曲を履歴に追加しました`);
    };
    if (needIds.length === 0) {
      finish([]);
      return;
    }
    libraryApi
      .getTracksByIds(needIds)
      .then((ts) => finish(ts))
      .catch((err) => {
        pushToast("error", `曲の取得に失敗: ${err}`);
      });
  }, [selected, selectedTrackIds, libraryTracks, refresh, pushToast]);

  const handleLoadToCrate = useCallback(async () => {
    if (!selected || selected.trackIds.length === 0) {
      pushToast("info", "履歴に曲がありません");
      return;
    }
    try {
      const ts = await libraryApi.getTracksByIds(selected.trackIds);
      const byId = new Map(ts.map((t) => [t.trackId, t]));
      const ordered: Track[] = [];
      for (const id of selected.trackIds) {
        const t = byId.get(id);
        if (t) ordered.push(t);
      }
      clearCrate();
      restoreCrateTracks(ordered);
      setRightRailVisible(true);
      setRailTab("crate");
      pushToast("success", `${ordered.length} 曲を Crate に読み込みました`);
    } catch (err) {
      pushToast("error", `Crate への読み込みに失敗: ${err}`);
    }
  }, [
    selected,
    clearCrate,
    restoreCrateTracks,
    setRightRailVisible,
    setRailTab,
    pushToast,
  ]);

  const runBindSearch = useCallback(async (q: string) => {
    const query = q.trim();
    if (!query) {
      setBindResults([]);
      return;
    }
    setBindSearching(true);
    try {
      const ts = await libraryApi.searchTracks(query, 30, 0);
      setBindResults(ts);
    } catch (err) {
      console.error(err);
      setBindResults([]);
    } finally {
      setBindSearching(false);
    }
  }, []);

  const handleResolve = useCallback(
    (unresolvedIndex: number, track: Track) => {
      if (!selected) return;
      resolveSetHistoryUnresolved(selected.id, unresolvedIndex, {
        trackId: track.trackId,
        persistentId: track.persistentId,
      });
      setBindForIndex(null);
      setBindQuery("");
      setBindResults([]);
      refresh();
      pushToast("success", `「${track.name ?? "?"}」を紐付けました`);
    },
    [selected, refresh, pushToast],
  );

  // ── List mode ──
  if (!selected) {
    return (
      <div className="set-history">
        <div className="set-history-toolbar">
          <div className="set-history-toolbar-title">
            <Icon name="history" size={16} />
            <span>Set History</span>
            <span className="set-history-count">{entries.length}</span>
          </div>
          <div className="set-history-toolbar-actions">
            <button
              type="button"
              className="toolbar-btn"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
              title="M3U / CSV からインポート"
            >
              <Icon name="upload" size={14} />
              {importing ? "Importing…" : "Import…"}
            </button>
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={handleNewManual}
              title="空の履歴を手動作成"
            >
              <Icon name="plus" size={14} />
              New manual
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".m3u,.m3u8,.csv,.txt,audio/x-mpegurl,text/csv,text/plain"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
              }}
            />
          </div>
        </div>

        {entries.length === 0 ? (
          <div className="set-history-empty">
            <Icon name="history" size={28} />
            <p>
              まだ演奏履歴がありません。
              <br />
              DJ ソフトから書き出した <strong>M3U / CSV</strong> を Import
              するか、New manual で空の履歴を作れます。
            </p>
            <p className="set-history-empty-note">
              MVP は localStorage 保存です（キー: crateforge-set-history）。
              将来 SQLite へ昇格できます。Traktor NML は未対応（今後）。
            </p>
          </div>
        ) : (
          <ul className="set-history-list">
            {entries.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className="set-history-row"
                  onClick={() => setSelectedId(e.id)}
                >
                  <div className="set-history-row-main">
                    <span className="set-history-row-name">{e.name}</span>
                    <span className="set-history-row-meta">
                      {fmtDate(e.performedAt)}
                      {e.eventName ? ` · ${e.eventName}` : ""}
                    </span>
                  </div>
                  <div className="set-history-row-side">
                    <span className="set-history-pill">
                      {e.trackIds.length} 曲
                    </span>
                    <span className="set-history-pill muted">
                      {SOURCE_LABEL[e.source] ?? e.source}
                    </span>
                    {(e.unresolved?.length ?? 0) > 0 && (
                      <span
                        className="set-history-pill warn"
                        title="未解決のインポート行"
                      >
                        {e.unresolved!.length} 未解決
                      </span>
                    )}
                    <Icon name="chevronR" size={14} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── Detail mode ──
  return (
    <div className="set-history set-history-detail">
      <div className="set-history-toolbar">
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setSelectedId(null)}
        >
          <Icon name="chevronR" size={14} style={{ transform: "rotate(180deg)" }} />
          Back
        </button>
        <div className="set-history-toolbar-title">
          <Icon name="history" size={16} />
          <span className="set-history-detail-title">{selected.name}</span>
        </div>
        <div className="set-history-toolbar-actions">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => handleAddSelected()}
            title="ライブラリで選択中の曲を履歴末尾に追加"
          >
            <Icon name="plus" size={14} />
            Add selected
          </button>
          <button
            type="button"
            className="toolbar-btn primary"
            onClick={() => void handleLoadToCrate()}
            disabled={selected.trackIds.length === 0}
            title="履歴の曲を Staging Crate に読み込む"
          >
            <Icon name="layers" size={14} />
            Load to Crate
          </button>
          <button
            type="button"
            className="toolbar-btn danger"
            onClick={handleDelete}
          >
            <Icon name="trash" size={14} />
            Delete
          </button>
        </div>
      </div>

      <div className="set-history-detail-body">
        <section className="set-history-card">
          <h3 className="set-history-card-title">Meta</h3>
          <div className="set-history-form">
            <label className="set-history-field">
              <span>Name</span>
              <input
                type="text"
                value={selected.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setEntries((prev) =>
                    prev.map((x) =>
                      x.id === selected.id ? { ...x, name } : x,
                    ),
                  );
                }}
                onBlur={(e) => patchMeta({ name: e.target.value })}
              />
            </label>
            <label className="set-history-field">
              <span>Performed</span>
              <input
                type="date"
                value={performedAtInputValue(selected.performedAt)}
                onChange={(e) => {
                  const performedAt = e.target.value;
                  setEntries((prev) =>
                    prev.map((x) =>
                      x.id === selected.id ? { ...x, performedAt } : x,
                    ),
                  );
                  patchMeta({ performedAt });
                }}
              />
            </label>
            <label className="set-history-field">
              <span>Event</span>
              <input
                type="text"
                placeholder="optional"
                value={selected.eventName ?? ""}
                onChange={(e) => {
                  const eventName = e.target.value;
                  setEntries((prev) =>
                    prev.map((x) =>
                      x.id === selected.id ? { ...x, eventName } : x,
                    ),
                  );
                }}
                onBlur={(e) =>
                  patchMeta({
                    eventName: e.target.value.trim() || undefined,
                  })
                }
              />
            </label>
            <label className="set-history-field">
              <span>Notes</span>
              <input
                type="text"
                placeholder="optional"
                value={selected.notes ?? ""}
                onChange={(e) => {
                  const notes = e.target.value;
                  setEntries((prev) =>
                    prev.map((x) =>
                      x.id === selected.id ? { ...x, notes } : x,
                    ),
                  );
                }}
                onBlur={(e) =>
                  patchMeta({ notes: e.target.value.trim() || undefined })
                }
              />
            </label>
            <div className="set-history-field">
              <span>Source</span>
              <span className="set-history-static">
                {SOURCE_LABEL[selected.source] ?? selected.source}
              </span>
            </div>
          </div>
        </section>

        <section className="set-history-card">
          <h3 className="set-history-card-title">Gig Snapshot (Planned vs Played)</h3>
          <label className="set-history-field">
            <span>Link snapshot</span>
            <select
              value={selected.linkedSnapshotId ?? ""}
              onChange={(e) => {
                const v = e.target.value || null;
                patchMeta({ linkedSnapshotId: v });
              }}
            >
              <option value="">— none —</option>
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.summary.total} tracks)
                </option>
              ))}
            </select>
          </label>
          {linkedSnapshot && plannedVsPlayed && (
            <div className="set-history-compare">
              <div className="set-history-compare-stats">
                <div>
                  <strong>{plannedVsPlayed.plannedCount}</strong>
                  <span>planned</span>
                </div>
                <div>
                  <strong>{plannedVsPlayed.playedCount}</strong>
                  <span>played</span>
                </div>
                <div>
                  <strong>{plannedVsPlayed.skippedIds.length}</strong>
                  <span>skipped</span>
                </div>
                <div>
                  <strong>{plannedVsPlayed.addedIds.length}</strong>
                  <span>added</span>
                </div>
              </div>
              <p className="set-history-compare-hint">
                Snapshot「{linkedSnapshot.name}」との差分（ID 集合比較）。
                skipped = 予定にあって未演奏 / added = 予定外で演奏。
              </p>
            </div>
          )}
          {!linkedSnapshot && selected.linkedSnapshotId && (
            <p className="set-history-muted">
              リンク先 Snapshot が見つかりません（削除済みの可能性）。
            </p>
          )}
        </section>

        <section className="set-history-card">
          <div className="set-history-card-head">
            <h3 className="set-history-card-title">
              Tracks{" "}
              <span className="set-history-count">{selected.trackIds.length}</span>
            </h3>
          </div>
          {loadingTracks ? (
            <p className="set-history-muted">読み込み中…</p>
          ) : detailTracks.length === 0 ? (
            <p className="set-history-muted">
              曲がありません。Import するか、ライブラリで選択して Add selected。
            </p>
          ) : (
            <ol className="set-history-tracks">
              {detailTracks.map((t, i) => (
                <li key={`${t.trackId}-${i}`} className="set-history-track">
                  <span className="set-history-track-idx">{i + 1}</span>
                  <div className="set-history-track-info">
                    <span className="set-history-track-name">
                      {t.name ?? "(untitled)"}
                    </span>
                    <span className="set-history-track-artist">
                      {t.artist ?? "—"}
                    </span>
                  </div>
                  <div className="set-history-track-actions">
                    <button
                      type="button"
                      className="set-history-icon-btn"
                      disabled={i === 0}
                      title="上へ"
                      onClick={() => handleMoveTrack(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="set-history-icon-btn"
                      disabled={i >= detailTracks.length - 1}
                      title="下へ"
                      onClick={() => handleMoveTrack(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="set-history-icon-btn danger"
                      title="削除"
                      onClick={() => handleRemoveTrack(t.trackId)}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {(selected.unresolved?.length ?? 0) > 0 && (
          <section className="set-history-card">
            <h3 className="set-history-card-title">
              Unresolved{" "}
              <span className="set-history-count warn">
                {selected.unresolved!.length}
              </span>
            </h3>
            <ul className="set-history-unresolved">
              {selected.unresolved!.map((u, ui) => (
                <li key={ui} className="set-history-unresolved-row">
                  <div className="set-history-unresolved-main">
                    <span className="set-history-unresolved-line">
                      {u.artist && u.title
                        ? `${u.artist} — ${u.title}`
                        : u.title || u.path || u.line}
                    </span>
                    {u.path && (
                      <span className="set-history-muted small">{u.path}</span>
                    )}
                  </div>
                  <div className="set-history-unresolved-actions">
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={() => {
                        setBindForIndex(ui);
                        const q =
                          [u.artist, u.title].filter(Boolean).join(" ") ||
                          u.path ||
                          "";
                        setBindQuery(q);
                        void runBindSearch(q);
                      }}
                    >
                      Search bind
                    </button>
                    <button
                      type="button"
                      className="set-history-icon-btn danger"
                      title="破棄"
                      onClick={() => {
                        removeSetHistoryUnresolved(selected.id, ui);
                        if (bindForIndex === ui) setBindForIndex(null);
                        refresh();
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                  {bindForIndex === ui && (
                    <div className="set-history-bind">
                      <div className="set-history-bind-row">
                        <input
                          type="search"
                          value={bindQuery}
                          placeholder="検索…"
                          onChange={(e) => setBindQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void runBindSearch(bindQuery);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="toolbar-btn"
                          disabled={bindSearching}
                          onClick={() => void runBindSearch(bindQuery)}
                        >
                          {bindSearching ? "…" : "Search"}
                        </button>
                      </div>
                      {bindResults.length > 0 && (
                        <ul className="set-history-bind-results">
                          {bindResults.map((t) => (
                            <li key={t.trackId}>
                              <button
                                type="button"
                                className="set-history-bind-pick"
                                onClick={() => handleResolve(ui, t)}
                              >
                                <span>{t.name ?? "?"}</span>
                                <span className="set-history-muted">
                                  {t.artist ?? "—"}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
