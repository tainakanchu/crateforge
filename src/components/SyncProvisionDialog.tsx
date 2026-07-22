import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as syncApi from "../api/sync";
import type {
  PlaylistSizeEstimate,
  ProvisionSummary,
  SyncProgress,
  SyncSource,
} from "../api/sync";
import type { Playlist } from "../types";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { SyncWritebackDialog } from "./SyncWritebackDialog";

interface SyncProvisionDialogProps {
  onClose: () => void;
  onLibraryChanged: () => void;
}

type Step =
  | "sources"
  | "connect"
  | "pairing"
  | "playlists"
  | "running"
  | "complete"
  | "failed";

const PAIRING_TIMEOUT_MS = 10 * 60 * 1000;
const PAIRING_POLL_MS = 2_000;

const PHASE_LABELS: Record<string, string> = {
  fetchingPlaylists: "取得中",
  fetchingAnalysis: "解析取得",
  downloading: "ダウンロード中",
  playlists: "プレイリスト作成中",
  complete: "完了",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  const digits = value >= 100 || power === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[power]}`;
}

function formatLastSync(value: string | null): string {
  if (!value) return "未同期";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `前回: ${date.toLocaleString("ja-JP")}`;
}

export function SyncProvisionDialog({
  onClose,
  onLibraryChanged,
}: SyncProvisionDialogProps) {
  const lastSyncDestRoot = useStore((state) => state.lastSyncDestRoot);
  const setLastSyncDestRoot = useStore((state) => state.setLastSyncDestRoot);

  const [step, setStep] = useState<Step>("sources");
  const [sources, setSources] = useState<SyncSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [selectedSource, setSelectedSource] = useState<SyncSource | null>(null);
  const [writebackSource, setWritebackSource] = useState<SyncSource | null>(null);
  const [remotePlaylists, setRemotePlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [selectedPids, setSelectedPids] = useState<Set<string>>(new Set());
  const [estimates, setEstimates] = useState<Record<number, PlaylistSizeEstimate>>({});
  const [estimateLoading, setEstimateLoading] = useState<Set<number>>(new Set());
  const [estimateErrors, setEstimateErrors] = useState<Record<number, string>>({});

  const [baseUrl, setBaseUrl] = useState("");
  const [deviceName, setDeviceName] = useState("このPC");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingSessionId, setPairingSessionId] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingDeadline, setPairingDeadline] = useState(0);

  const [destRoot, setDestRoot] = useState(lastSyncDestRoot ?? "");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [summary, setSummary] = useState<ProvisionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isProvisioning = step === "running";

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    setError(null);
    try {
      const result = await syncApi.syncListSources();
      setSources(result);
      return result;
    } catch (loadError) {
      setError(`接続先の読み込みに失敗しました: ${errorMessage(loadError)}`);
      return [];
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    loadSources();
    return () => previousFocusRef.current?.focus();
  }, [loadSources]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      (target ?? dialogRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [step, sourcesLoading, playlistsLoading, writebackSource]);

  useEffect(() => {
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    Promise.all([
      syncApi.onSyncProgress(setProgress),
      syncApi.onSyncComplete((result) => {
        setSummary(result);
        setProgress(null);
        setError(null);
        setStep("complete");
        onLibraryChanged();
      }),
      syncApi.onSyncError((message) => {
        setError(message);
        setProgress(null);
        setStep("failed");
      }),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((unlisten) => unlisten());
      else unlisteners = listeners;
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [onLibraryChanged]);

  const loadPlaylists = useCallback(async (source: SyncSource) => {
    setSelectedSource(source);
    setStep("playlists");
    setPlaylistsLoading(true);
    setRemotePlaylists([]);
    setSelectedPids(new Set());
    setEstimates({});
    setEstimateErrors({});
    setError(null);
    try {
      const result = await syncApi.syncListRemotePlaylists(source.id);
      setRemotePlaylists(result.filter((playlist) => !playlist.isFolder));
    } catch (loadError) {
      setError(`プレイリストの取得に失敗しました: ${errorMessage(loadError)}`);
    } finally {
      setPlaylistsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step !== "pairing" || !pairingSessionId) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= pairingDeadline) {
        setError("接続の承認待ちがタイムアウトしました。もう一度お試しください。");
        setPairingSessionId(null);
        return;
      }
      try {
        const paired = await syncApi.syncPairPoll(pairingSessionId);
        if (cancelled) return;
        if (paired) {
          const nextSources = await loadSources();
          if (cancelled) return;
          const source = nextSources.find((item) => item.serverId === paired.serverId);
          if (!source) {
            setError("接続先は承認されましたが、保存済み接続先を読み込めませんでした。");
            setPairingSessionId(null);
            return;
          }
          await loadPlaylists(source);
          return;
        }
        timer = window.setTimeout(poll, PAIRING_POLL_MS);
      } catch (pollError) {
        if (cancelled) return;
        setError(`承認の確認に失敗しました: ${errorMessage(pollError)}`);
        setPairingSessionId(null);
      }
    };

    timer = window.setTimeout(poll, PAIRING_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [step, pairingSessionId, pairingDeadline, loadPlaylists, loadSources]);

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        if (!isProvisioning) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [isProvisioning, onClose],
  );

  const handlePairStart = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!baseUrl.trim() || !deviceName.trim() || pairingBusy) return;
      setPairingBusy(true);
      setError(null);
      try {
        const result = await syncApi.syncPairStart(baseUrl.trim(), deviceName.trim());
        setPairingSessionId(result.sessionId);
        setPairingCode(result.code);
        setPairingDeadline(Date.now() + PAIRING_TIMEOUT_MS);
        setStep("pairing");
      } catch (startError) {
        setError(`接続を開始できませんでした: ${errorMessage(startError)}`);
      } finally {
        setPairingBusy(false);
      }
    },
    [baseUrl, deviceName, pairingBusy],
  );

  const retryPairing = useCallback(() => {
    setPairingSessionId(null);
    setPairingCode(null);
    setError(null);
    setStep("connect");
  }, []);

  const togglePlaylist = useCallback(
    async (playlist: Playlist) => {
      const pid = playlist.persistentId;
      if (!pid || !selectedSource) return;
      const checked = !selectedPids.has(pid);
      setSelectedPids((current) => {
        const next = new Set(current);
        if (checked) next.add(pid);
        else next.delete(pid);
        return next;
      });
      if (!checked || estimates[playlist.playlistId] || estimateLoading.has(playlist.playlistId)) {
        return;
      }
      setEstimateLoading((current) => new Set(current).add(playlist.playlistId));
      setEstimateErrors((current) => {
        const next = { ...current };
        delete next[playlist.playlistId];
        return next;
      });
      try {
        const estimate = await syncApi.syncPlaylistSizeEstimate(
          selectedSource.id,
          playlist.playlistId,
        );
        setEstimates((current) => ({ ...current, [playlist.playlistId]: estimate }));
      } catch (estimateError) {
        setEstimateErrors((current) => ({
          ...current,
          [playlist.playlistId]: errorMessage(estimateError),
        }));
      } finally {
        setEstimateLoading((current) => {
          const next = new Set(current);
          next.delete(playlist.playlistId);
          return next;
        });
      }
    },
    [selectedSource, selectedPids, estimates, estimateLoading],
  );

  const selectedEstimate = useMemo(
    () =>
      remotePlaylists.reduce(
        (total, playlist) => {
          if (!playlist.persistentId || !selectedPids.has(playlist.persistentId)) return total;
          const estimate = estimates[playlist.playlistId];
          if (!estimate) return total;
          total.bytes += estimate.totalBytes;
          total.missing += estimate.missingFiles;
          total.loaded += 1;
          return total;
        },
        { bytes: 0, missing: 0, loaded: 0 },
      ),
    [remotePlaylists, selectedPids, estimates],
  );
  const firstSelectablePlaylistId = remotePlaylists.find(
    (playlist) => !!playlist.persistentId,
  )?.playlistId;

  const pickDestination = useCallback(async () => {
    const directory = await open({
      directory: true,
      multiple: false,
      defaultPath: destRoot || undefined,
    });
    if (typeof directory !== "string") return;
    setDestRoot(directory);
    setLastSyncDestRoot(directory);
  }, [destRoot, setLastSyncDestRoot]);

  const startProvision = useCallback(async () => {
    if (!selectedSource || selectedPids.size === 0 || !destRoot.trim()) return;
    setLastSyncDestRoot(destRoot.trim());
    setSummary(null);
    setError(null);
    setProgress({
      phase: "fetchingPlaylists",
      current: 0,
      total: selectedPids.size,
      trackName: null,
    });
    setStep("running");
    try {
      const result = await syncApi.syncProvision(
        selectedSource.id,
        Array.from(selectedPids),
        destRoot.trim(),
      );
      if (!result.started) throw new Error("同期ジョブを開始できませんでした");
    } catch (provisionError) {
      setError(errorMessage(provisionError));
      setProgress(null);
      setStep("failed");
    }
  }, [selectedSource, selectedPids, destRoot, setLastSyncDestRoot]);

  const handleProvisionSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      startProvision();
    },
    [startProvision],
  );

  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  if (writebackSource) {
    return (
      <SyncWritebackDialog
        source={writebackSource}
        onBack={() => setWritebackSource(null)}
        onClose={onClose}
        onLibraryChanged={onLibraryChanged}
      />
    );
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isProvisioning) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal sync-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-dialog-title"
        tabIndex={-1}
        onKeyDownCapture={handleDialogKeyDown}
      >
        <div className="modal-header">
          <h2 id="sync-dialog-title">
            <Icon name="download" size={16} /> サーバーから取り寄せ
          </h2>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={isProvisioning}
            aria-label="閉じる"
            title={isProvisioning ? "取り寄せ中は閉じられません" : "閉じる (Esc)"}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body sync-body">
          {step === "sources" && (
            <section>
              <h3 className="sync-section-title">接続先を選択</h3>
              {sourcesLoading ? (
                <div className="sync-empty">接続先を読み込んでいます…</div>
              ) : sources.length > 0 ? (
                <div className="sync-source-list">
                  {sources.map((source, index) => (
                    <div key={source.id} className="sync-source">
                      <Icon name="disc" size={18} />
                      <span className="sync-source-copy">
                        <strong>{source.name?.trim() || source.baseUrl}</strong>
                        <span>{source.baseUrl}</span>
                      </span>
                      <span className="sync-source-meta">{formatLastSync(source.lastSyncAt)}</span>
                      <span className="sync-source-actions">
                        <button
                          className="toolbar-btn"
                          type="button"
                          onClick={() => loadPlaylists(source)}
                          data-autofocus={index === 0 ? true : undefined}
                        >
                          <Icon name="download" size={14} /> 取り寄せ
                        </button>
                        <button
                          className="toolbar-btn"
                          type="button"
                          onClick={() => {
                            setError(null);
                            setWritebackSource(source);
                          }}
                        >
                          <Icon name="upload" size={14} /> 母艦へ書き戻す
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sync-empty">接続済みのサーバーはありません。</div>
              )}
              {error && <div className="sync-error" role="alert">{error}</div>}
              <div className="sync-actions">
                {error && (
                  <button className="toolbar-btn" onClick={loadSources} data-autofocus>
                    再読み込み
                  </button>
                )}
                <button
                  className="toolbar-btn primary"
                  onClick={() => {
                    setError(null);
                    setStep("connect");
                  }}
                  data-autofocus={sources.length === 0 && !error ? true : undefined}
                >
                  <Icon name="plus" size={14} /> 新しいサーバーに接続
                </button>
              </div>
            </section>
          )}

          {step === "connect" && (
            <form onSubmit={handlePairStart}>
              <h3 className="sync-section-title">新しいサーバーに接続</h3>
              <label className="sync-field">
                <span>サーバー URL</span>
                <input
                  className="rip-input"
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://192.168.x.x:PORT"
                  autoComplete="url"
                  spellCheck={false}
                  required
                  data-autofocus
                />
              </label>
              <label className="sync-field">
                <span>この端末の名前</span>
                <input
                  className="rip-input"
                  type="text"
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  autoComplete="off"
                  required
                />
              </label>
              {error && <div className="sync-error" role="alert">{error}</div>}
              <div className="sync-actions">
                <button className="toolbar-btn" type="button" onClick={() => setStep("sources")}>
                  戻る
                </button>
                <button
                  className="toolbar-btn primary"
                  type="submit"
                  disabled={pairingBusy || !baseUrl.trim() || !deviceName.trim()}
                >
                  {pairingBusy ? "接続中…" : "接続する"}
                </button>
              </div>
            </form>
          )}

          {step === "pairing" && (
            <section className="sync-pairing">
              <div className="sync-pairing-label">確認コード</div>
              <div className="sync-code" aria-label={`確認コード ${pairingCode ?? ""}`}>
                {pairingCode ?? "------"}
              </div>
              <h3>母艦側で承認してください</h3>
              <p>承認されると、自動的に次の画面へ進みます。</p>
              {!error && <div className="sync-waiting">承認を待っています…</div>}
              {error && <div className="sync-error" role="alert">{error}</div>}
              {error && (
                <div className="sync-actions">
                  <button className="toolbar-btn primary" onClick={retryPairing} data-autofocus>
                    もう一度試す
                  </button>
                </div>
              )}
            </section>
          )}

          {step === "playlists" && selectedSource && (
            <form onSubmit={handleProvisionSubmit}>
              <div className="sync-playlist-heading">
                <div>
                  <h3 className="sync-section-title">プレイリストを選択</h3>
                  <span>{selectedSource.name?.trim() || selectedSource.baseUrl}</span>
                </div>
                <button className="rip-link" type="button" onClick={() => setStep("sources")}>
                  接続先を変更
                </button>
              </div>

              {playlistsLoading ? (
                <div className="sync-empty">プレイリストを取得しています…</div>
              ) : remotePlaylists.length > 0 ? (
                <div className="sync-playlist-list">
                  {remotePlaylists.map((playlist) => {
                    const pid = playlist.persistentId;
                    const checked = !!pid && selectedPids.has(pid);
                    const estimate = estimates[playlist.playlistId];
                    const loading = estimateLoading.has(playlist.playlistId);
                    const estimateError = estimateErrors[playlist.playlistId];
                    return (
                      <label
                        className={`sync-playlist${pid ? "" : " disabled"}`}
                        key={playlist.playlistId}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePlaylist(playlist)}
                          disabled={!pid}
                          data-autofocus={
                            playlist.playlistId === firstSelectablePlaylistId ? true : undefined
                          }
                        />
                        <span className="sync-playlist-name">{playlist.name}</span>
                        <span className="sync-playlist-count">
                          {playlist.trackCount.toLocaleString()} 曲
                        </span>
                        <span className="sync-playlist-size">
                          {loading
                            ? "計算中…"
                            : estimate
                              ? `約 ${formatBytes(estimate.totalBytes)}`
                              : estimateError
                                ? "サイズ取得失敗"
                                : checked
                                  ? "計算待ち…"
                                  : ""}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : !error ? (
                <div className="sync-empty">取り寄せ可能なプレイリストがありません。</div>
              ) : null}

              {error && (
                <div className="sync-error" role="alert">
                  {error}
                  <button
                    className="rip-link"
                    type="button"
                    onClick={() => loadPlaylists(selectedSource)}
                  >
                    再試行
                  </button>
                </div>
              )}

              <div className="sync-selection-total" aria-live="polite">
                <strong>{selectedPids.size.toLocaleString()} 件選択</strong>
                <span>
                  概算 {formatBytes(selectedEstimate.bytes)}
                  {selectedEstimate.loaded < selectedPids.size ? "（計算中を除く）" : ""}
                </span>
                {selectedEstimate.missing > 0 && (
                  <span className="sync-missing">
                    欠損ファイル {selectedEstimate.missing.toLocaleString()} 件
                  </span>
                )}
              </div>

              <div className="sync-field sync-destination">
                <span>保存先</span>
                <div className="sync-folder-row">
                  <input
                    className="rip-input"
                    type="text"
                    value={destRoot}
                    readOnly
                    placeholder="保存先フォルダを選択…"
                  />
                  <button className="toolbar-btn" type="button" onClick={pickDestination}>
                    <Icon name="folderOpen" size={14} /> 選択
                  </button>
                </div>
              </div>

              <div className="sync-actions">
                <button className="toolbar-btn" type="button" onClick={() => setStep("sources")}>
                  戻る
                </button>
                <button
                  className="toolbar-btn primary"
                  type="submit"
                  disabled={selectedPids.size === 0 || !destRoot.trim() || playlistsLoading}
                >
                  取り寄せを開始
                </button>
              </div>
            </form>
          )}

          {step === "running" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="download" size={24} /></div>
              <h3>{PHASE_LABELS[progress?.phase ?? ""] ?? "処理中"}</h3>
              <progress
                max={progress?.total || 1}
                value={progress?.current ?? 0}
                aria-label="取り寄せの進捗"
              />
              <div className="sync-progress-numbers">
                <span>{progress?.current.toLocaleString() ?? 0} / {progress?.total.toLocaleString() ?? 0}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="sync-current-track">
                {progress?.trackName || "サーバーから情報を取得しています…"}
              </div>
              <p>完了するまで、この画面を閉じずにお待ちください。</p>
            </section>
          )}

          {step === "complete" && summary && (
            <section className="sync-result">
              <div className="sync-result-icon success"><Icon name="check" size={26} /></div>
              <h3>取り寄せが完了しました</h3>
              <dl className="sync-summary">
                <div><dt>曲数</dt><dd>{summary.tracks.toLocaleString()} 曲</dd></div>
                <div><dt>プレイリスト数</dt><dd>{summary.playlists.toLocaleString()} 件</dd></div>
                <div><dt>合計サイズ</dt><dd>{formatBytes(summary.bytes)}</dd></div>
              </dl>
              {summary.failures.length > 0 && (
                <details className="sync-failures">
                  <summary>失敗一覧（{summary.failures.length.toLocaleString()} 件）</summary>
                  <ul>
                    {summary.failures.map((failure, index) => (
                      <li key={`${failure.persistentId ?? "failure"}-${index}`}>
                        <strong>{failure.trackName || failure.persistentId || "不明な曲"}</strong>
                        <span>{failure.error}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="sync-actions">
                <button className="toolbar-btn primary" onClick={onClose} data-autofocus>
                  閉じる
                </button>
              </div>
            </section>
          )}

          {step === "failed" && (
            <section className="sync-result">
              <div className="sync-result-icon error"><Icon name="x" size={26} /></div>
              <h3>取り寄せに失敗しました</h3>
              <div className="sync-error" role="alert">{error || "不明なエラーが発生しました。"}</div>
              <div className="sync-actions">
                <button className="toolbar-btn" onClick={() => setStep("playlists")}>
                  選択画面に戻る
                </button>
                <button className="toolbar-btn primary" onClick={startProvision} data-autofocus>
                  再試行
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
