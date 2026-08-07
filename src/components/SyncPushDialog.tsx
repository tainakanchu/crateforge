import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import * as syncApi from "../api/sync";
import type {
  PushableTrack,
  PushTracksSummary,
  SyncProgress,
  SyncSource,
} from "../api/sync";
import { Icon } from "./Icon";

interface SyncPushDialogProps {
  source: SyncSource;
  onBack: () => void;
  onClose: () => void;
  onLibraryChanged: () => void;
}

type Step = "loading" | "select" | "pushing" | "complete" | "failed";

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

export function SyncPushDialog({
  source,
  onBack,
  onClose,
  onLibraryChanged,
}: SyncPushDialogProps) {
  const [step, setStep] = useState<Step>("loading");
  const [tracks, setTracks] = useState<PushableTrack[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [summary, setSummary] = useState<PushTracksSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadSucceeded, setLoadSucceeded] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const completeHandledRef = useRef(false);
  const isPushing = step === "pushing";
  const sourceName = source.name?.trim() || source.baseUrl;

  const finishPush = useCallback(
    (result: PushTracksSummary) => {
      if (completeHandledRef.current) return;
      completeHandledRef.current = true;
      setSummary(result);
      setProgress(null);
      setError(null);
      setStep("complete");
      onLibraryChanged();
    },
    [onLibraryChanged],
  );

  const loadPushable = useCallback(async () => {
    setStep("loading");
    setTracks([]);
    setSelectedIds(new Set());
    setSummary(null);
    setError(null);
    setLoadSucceeded(false);
    try {
      const result = await syncApi.syncListPushable(source.id);
      setTracks(result);
      setSelectedIds(new Set(result.map((track) => track.persistentId)));
      setLoadSucceeded(true);
      setStep("select");
    } catch (loadError) {
      setError(`送信できる曲を確認できませんでした: ${errorMessage(loadError)}`);
      setStep("failed");
    }
  }, [source.id]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      (target ?? dialogRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    Promise.all([
      syncApi.onSyncProgress((nextProgress) => {
        if (nextProgress.phase === "pushing") setProgress(nextProgress);
      }),
      syncApi.onPushComplete(finishPush),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((unlisten) => unlisten());
      else unlisteners = listeners;
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [finishPush]);

  useEffect(() => {
    void loadPushable();
  }, [loadPushable]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate =
      selectedIds.size > 0 && selectedIds.size < tracks.length;
  }, [selectedIds.size, tracks.length]);

  const selectedBytes = useMemo(
    () =>
      tracks.reduce(
        (total, track) => total + (selectedIds.has(track.persistentId) ? track.bytes : 0),
        0,
      ),
    [selectedIds, tracks],
  );

  const toggleTrack = useCallback((persistentId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(persistentId)) next.delete(persistentId);
      else next.add(persistentId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((current) =>
      current.size === tracks.length
        ? new Set()
        : new Set(tracks.map((track) => track.persistentId)),
    );
  }, [tracks]);

  const startPush = useCallback(async () => {
    if (isPushing || selectedIds.size === 0) return;
    const persistentIds = tracks
      .filter((track) => selectedIds.has(track.persistentId))
      .map((track) => track.persistentId);
    completeHandledRef.current = false;
    setSummary(null);
    setError(null);
    setProgress({
      phase: "pushing",
      current: 0,
      total: persistentIds.length,
      trackName: null,
    });
    setStep("pushing");
    try {
      const result = await syncApi.syncPushTracks(source.id, persistentIds);
      finishPush(result);
    } catch (pushError) {
      setError(`母艦への送信に失敗しました: ${errorMessage(pushError)}`);
      setProgress(null);
      setStep("failed");
    }
  }, [finishPush, isPushing, selectedIds, source.id, tracks]);

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        if (!isPushing) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
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
    [isPushing, onClose],
  );

  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPushing) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal sync-modal sync-push-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-push-dialog-title"
        tabIndex={-1}
        onKeyDownCapture={handleDialogKeyDown}
      >
        <div className="modal-header">
          <h2 id="sync-push-dialog-title">
            <Icon name="upload" size={16} /> 母艦へ送る
          </h2>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={isPushing}
            aria-label="閉じる"
            title={isPushing ? "送信中は閉じられません" : "閉じる (Esc)"}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body sync-body">
          {step === "loading" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="upload" size={24} /></div>
              <h3>送信できる曲を確認しています</h3>
              <div className="sync-current-track">{sourceName}</div>
              <p>手元で追加された曲を読み込んでいます。</p>
            </section>
          )}

          {step === "select" && (
            <section>
              <div className="sync-playlist-heading">
                <div>
                  <h3 className="sync-section-title">送信する曲を選択</h3>
                  <span>{sourceName}</span>
                </div>
                <button className="rip-link" type="button" onClick={onBack}>
                  接続先を変更
                </button>
              </div>

              {tracks.length > 0 ? (
                <>
                  <label className="sync-push-select-all">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={selectedIds.size === tracks.length}
                      onChange={toggleAll}
                      data-autofocus
                    />
                    すべて選択
                  </label>
                  <div className="sync-push-table">
                    <div className="sync-push-columns" aria-hidden="true">
                      <span />
                      <span>曲名</span>
                      <span>アーティスト</span>
                      <span>アルバム</span>
                      <span>サイズ</span>
                      <span>解析</span>
                    </div>
                    <div className="sync-push-list">
                      {tracks.map((track) => (
                        <label className="sync-push-row" key={track.persistentId}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(track.persistentId)}
                            onChange={() => toggleTrack(track.persistentId)}
                          />
                          <strong title={track.name || undefined}>{track.name || "曲名なし"}</strong>
                          <span title={track.artist || undefined}>{track.artist || "—"}</span>
                          <span title={track.album || undefined}>{track.album || "—"}</span>
                          <span>{formatBytes(track.bytes)}</span>
                          <span className={`sync-analysis-badge${track.hasAnalysis ? " available" : ""}`}>
                            {track.hasAnalysis ? "解析あり" : "解析なし"}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="sync-selection-total" aria-live="polite">
                    <strong>{selectedIds.size.toLocaleString()} 曲選択</strong>
                    <span>合計 {formatBytes(selectedBytes)}</span>
                  </div>
                </>
              ) : (
                <div className="sync-empty">母艦へ送る曲はありません</div>
              )}

              <div className="sync-actions">
                <button className="toolbar-btn" type="button" onClick={onBack}>
                  戻る
                </button>
                {tracks.length > 0 && (
                  <button
                    className="toolbar-btn primary"
                    type="button"
                    onClick={startPush}
                    disabled={selectedIds.size === 0}
                  >
                    <Icon name="upload" size={14} /> 送信
                  </button>
                )}
              </div>
            </section>
          )}

          {step === "pushing" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="upload" size={24} /></div>
              <h3>母艦へ送信しています</h3>
              <progress
                max={progress?.total || 1}
                value={progress?.current ?? 0}
                aria-label="母艦への送信の進捗"
              />
              <div className="sync-progress-numbers">
                <span>{progress?.current.toLocaleString() ?? 0} / {progress?.total.toLocaleString() ?? 0}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="sync-current-track">
                {progress?.trackName || "送信を準備しています…"}
              </div>
              <p>完了するまで、この画面を閉じずにお待ちください。</p>
            </section>
          )}

          {step === "complete" && summary && (
            <section className="sync-result">
              <div className={`sync-result-icon${summary.failures.length > 0 ? " warning" : " success"}`}>
                <Icon name={summary.failures.length > 0 ? "warning" : "check"} size={26} />
              </div>
              <h3>
                {summary.failures.length > 0
                  ? `母艦への送信が完了しました（${summary.failures.length.toLocaleString()} 件の失敗あり）`
                  : "母艦への送信が完了しました"}
              </h3>
              <dl className="sync-summary">
                <div><dt>アップロード済</dt><dd>{summary.uploaded.toLocaleString()} 曲</dd></div>
                <div><dt>既存</dt><dd>{summary.alreadyExisted.toLocaleString()} 曲</dd></div>
                <div><dt>解析送信</dt><dd>{summary.analysesPushed.toLocaleString()} 件</dd></div>
              </dl>
              {summary.failures.length > 0 && (
                <details className="sync-failures" open>
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
                <button className="toolbar-btn" onClick={onBack}>
                  接続先に戻る
                </button>
                <button className="toolbar-btn primary" onClick={onClose} data-autofocus>
                  閉じる
                </button>
              </div>
            </section>
          )}

          {step === "failed" && (
            <section className="sync-result">
              <div className="sync-result-icon error"><Icon name="x" size={26} /></div>
              <h3>{loadSucceeded ? "母艦への送信に失敗しました" : "曲を確認できませんでした"}</h3>
              <div className="sync-error" role="alert">
                {error || "不明なエラーが発生しました。"}
              </div>
              <div className="sync-actions">
                <button className="toolbar-btn" onClick={onBack}>
                  接続先に戻る
                </button>
                {loadSucceeded ? (
                  <button className="toolbar-btn primary" onClick={() => setStep("select")} data-autofocus>
                    選択画面に戻る
                  </button>
                ) : (
                  <button className="toolbar-btn primary" onClick={loadPushable} data-autofocus>
                    再試行
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
