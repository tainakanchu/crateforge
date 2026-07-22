import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import * as syncApi from "../api/sync";
import type {
  EvictionCandidate,
  EvictionSummary,
  EditableSyncSelectionPolicy,
  ResyncSummary,
  StorageUsage,
  SyncProgress,
  SyncSelection,
  SyncSource,
} from "../api/sync";
import { Icon } from "./Icon";

interface SyncManagementDialogProps {
  source: SyncSource;
  onBack: () => void;
  onClose: () => void;
  onLibraryChanged: () => void;
}

type Step =
  | "loading"
  | "manage"
  | "resyncing"
  | "resyncComplete"
  | "candidates"
  | "evictConfirm"
  | "evicting"
  | "evictComplete";

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

function Failures({ failures }: { failures: ResyncSummary["failures"] }) {
  if (failures.length === 0) return null;
  return (
    <details className="sync-failures">
      <summary>失敗一覧（{failures.length.toLocaleString()} 件）</summary>
      <ul>
        {failures.map((failure, index) => (
          <li key={`${failure.persistentId ?? "failure"}-${index}`}>
            <strong>{failure.trackName || failure.persistentId || "不明な項目"}</strong>
            <span>{failure.error}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function SyncManagementDialog({
  source,
  onBack,
  onClose,
  onLibraryChanged,
}: SyncManagementDialogProps) {
  const [step, setStep] = useState<Step>("loading");
  const [selections, setSelections] = useState<SyncSelection[]>([]);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [policyBusy, setPolicyBusy] = useState<Set<number>>(new Set());
  const [removeBusy, setRemoveBusy] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [resyncSummary, setResyncSummary] = useState<ResyncSummary | null>(null);
  const [candidates, setCandidates] = useState<EvictionCandidate[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [evictionSummary, setEvictionSummary] = useState<EvictionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const resyncHandledRef = useRef(false);
  const isBusy = step === "resyncing" || step === "evicting";

  const loadManagement = useCallback(async (nextStep: Step = "manage") => {
    setError(null);
    try {
      const [nextSelections, nextUsage] = await Promise.all([
        syncApi.syncListSelections(source.id),
        syncApi.syncStorageUsage(source.id),
      ]);
      setSelections(nextSelections);
      setUsage(nextUsage);
      setStep(nextStep);
    } catch (loadError) {
      setError(`同期情報を読み込めませんでした: ${errorMessage(loadError)}`);
      setStep("manage");
    }
  }, [source.id]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    void loadManagement();
    return () => previousFocusRef.current?.focus();
  }, [loadManagement]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      (target ?? dialogRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [step]);

  const finishResync = useCallback((summary: ResyncSummary) => {
    if (resyncHandledRef.current) return;
    resyncHandledRef.current = true;
    setResyncSummary(summary);
    setProgress(null);
    setError(null);
    setStep("resyncComplete");
    onLibraryChanged();
    void loadManagement("resyncComplete");
  }, [loadManagement, onLibraryChanged]);

  useEffect(() => {
    let disposed = false;
    let unlisteners: Array<() => void> = [];
    Promise.all([
      syncApi.onSyncProgress((nextProgress) => {
        if (nextProgress.phase === "resyncing") setProgress(nextProgress);
      }),
      syncApi.onResyncComplete(finishResync),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((unlisten) => unlisten());
      else unlisteners = listeners;
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [finishResync]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate =
      selectedCandidates.size > 0 && selectedCandidates.size < candidates.length;
  }, [candidates.length, selectedCandidates.size]);

  const handleDialogKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      if (!isBusy) {
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
  }, [isBusy, onClose]);

  const changePolicy = useCallback(async (
    selection: SyncSelection,
    policy: EditableSyncSelectionPolicy,
  ) => {
    if (selection.policy === policy || policyBusy.has(selection.id)) return;
    setPolicyBusy((current) => new Set(current).add(selection.id));
    setError(null);
    try {
      await syncApi.syncSetSelectionPolicy(selection.id, policy);
      setSelections((current) => current.map((item) =>
        item.id === selection.id ? { ...item, policy } : item,
      ));
    } catch (policyError) {
      setError(`同期方法を変更できませんでした: ${errorMessage(policyError)}`);
    } finally {
      setPolicyBusy((current) => {
        const next = new Set(current);
        next.delete(selection.id);
        return next;
      });
    }
  }, [policyBusy]);

  const startResync = useCallback(async () => {
    resyncHandledRef.current = false;
    setResyncSummary(null);
    setError(null);
    setProgress({ phase: "resyncing", current: 0, total: selections.length, trackName: null });
    setStep("resyncing");
    try {
      finishResync(await syncApi.syncResync(source.id));
    } catch (resyncError) {
      setError(`再同期に失敗しました: ${errorMessage(resyncError)}`);
      setProgress(null);
      setStep("manage");
    }
  }, [finishResync, selections.length, source.id]);

  const loadCandidates = useCallback(async () => {
    setError(null);
    setStep("loading");
    try {
      const nextCandidates = await syncApi.syncEvictionCandidates(source.id);
      setCandidates(nextCandidates);
      setSelectedCandidates(new Set(nextCandidates.map((candidate) => candidate.persistentId)));
      setStep("candidates");
    } catch (candidateError) {
      setError(`削除候補を読み込めませんでした: ${errorMessage(candidateError)}`);
      setStep("manage");
    }
  }, [source.id]);

  // selection の参照だけを外す。孤立した曲は続けて削除候補画面で確認・削除する。
  const removeSelection = useCallback(async (selection: SyncSelection) => {
    if (removeBusy.has(selection.id)) return;
    if (!window.confirm("この selection を解除します。参照されなくなった曲は次の画面で削除できます")) return;
    setRemoveBusy((current) => new Set(current).add(selection.id));
    setError(null);
    try {
      await syncApi.syncRemoveSelection(selection.id);
      await loadManagement();
      await loadCandidates();
    } catch (removeError) {
      setError(`selection を解除できませんでした: ${errorMessage(removeError)}`);
    } finally {
      setRemoveBusy((current) => {
        const next = new Set(current);
        next.delete(selection.id);
        return next;
      });
    }
  }, [removeBusy, loadManagement, loadCandidates]);

  const selectedCandidateBytes = useMemo(() => candidates.reduce(
    (total, candidate) => selectedCandidates.has(candidate.persistentId) ? total + candidate.bytes : total,
    0,
  ), [candidates, selectedCandidates]);

  const runEviction = useCallback(async () => {
    const persistentIds = Array.from(selectedCandidates);
    if (persistentIds.length === 0) return;
    setEvictionSummary(null);
    setError(null);
    setStep("evicting");
    try {
      const summary = await syncApi.syncEvict(persistentIds);
      setEvictionSummary(summary);
      setStep("evictComplete");
      onLibraryChanged();
    } catch (evictError) {
      setError(`ファイルを削除できませんでした: ${errorMessage(evictError)}`);
      setStep("evictConfirm");
    }
  }, [onLibraryChanged, selectedCandidates]);

  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;
  const usageBySelection = useMemo(() => new Map(
    usage?.selections.map((item) => [item.selectionId, item]) ?? [],
  ), [usage]);
  const sourceName = source.name?.trim() || source.baseUrl;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isBusy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal sync-modal sync-management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-management-title"
        tabIndex={-1}
        onKeyDownCapture={handleDialogKeyDown}
      >
        <div className="modal-header">
          <h2 id="sync-management-title">
            <Icon name="settings" size={16} /> 同期の管理
          </h2>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={isBusy}
            aria-label="閉じる"
            title={isBusy ? "処理中は閉じられません" : "閉じる (Esc)"}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body sync-body">
          {step === "loading" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="settings" size={24} /></div>
              <h3>同期情報を読み込んでいます</h3>
            </section>
          )}

          {step === "manage" && (
            <section>
              <div className="sync-playlist-heading">
                <div>
                  <h3 className="sync-section-title">selection</h3>
                  <span>{sourceName}</span>
                </div>
              </div>

              {selections.length > 0 ? (
                <div className="sync-management-list">
                  <div className="sync-management-columns" aria-hidden="true">
                    <span>名前</span><span>同期方法</span><span>曲数</span><span>容量</span><span></span>
                  </div>
                  {selections.map((selection, index) => {
                    const rowUsage = usageBySelection.get(selection.id);
                    const busy = policyBusy.has(selection.id);
                    const removing = removeBusy.has(selection.id);
                    return (
                      <div className="sync-management-row" key={selection.id}>
                        <strong>{selection.name || selection.remotePid}</strong>
                        <div className="sync-policy-control" aria-label={`${selection.name} の同期方法`}>
                          <button
                            type="button"
                            className={selection.policy === "snapshot" ? "active" : ""}
                            onClick={() => changePolicy(selection, "snapshot")}
                            disabled={busy}
                            aria-pressed={selection.policy === "snapshot"}
                            data-autofocus={index === 0 ? true : undefined}
                          >
                            スナップショット
                          </button>
                          <button
                            type="button"
                            className={selection.policy === "follow" ? "active" : ""}
                            onClick={() => changePolicy(selection, "follow")}
                            disabled={busy}
                            aria-pressed={selection.policy === "follow"}
                          >
                            追従
                          </button>
                        </div>
                        <span>{rowUsage?.trackCount.toLocaleString() ?? "—"} 曲</span>
                        <span>
                          {rowUsage ? formatBytes(rowUsage.bytes) : "—"}
                          {!!rowUsage?.missingFiles && (
                            <small>欠損 {rowUsage.missingFiles.toLocaleString()}</small>
                          )}
                        </span>
                        <button
                          type="button"
                          className="toolbar-btn sync-selection-remove"
                          onClick={() => removeSelection(selection)}
                          disabled={removing}
                          title="この selection を解除します"
                        >
                          <Icon name="x" size={12} /> 解除
                        </button>
                      </div>
                    );
                  })}
                  <div className="sync-management-total">
                    <strong>合計</strong><span />
                    <span>{usage?.total.trackCount.toLocaleString() ?? "—"} 曲</span>
                    <span>{usage ? formatBytes(usage.total.bytes) : "—"}</span>
                    <span />
                  </div>
                </div>
              ) : (
                <div className="sync-empty">管理できる selection はありません。</div>
              )}

              {error && <div className="sync-error" role="alert">{error}</div>}
              <div className="sync-actions sync-management-actions">
                <button className="toolbar-btn" type="button" onClick={onBack}>戻る</button>
                <button className="toolbar-btn" type="button" onClick={loadCandidates}>
                  <Icon name="trash" size={14} /> 削除候補を確認
                </button>
                <button
                  className="toolbar-btn primary"
                  type="button"
                  onClick={startResync}
                  disabled={selections.length === 0}
                >
                  <Icon name="repeat" size={14} /> 再同期
                </button>
              </div>
            </section>
          )}

          {step === "resyncing" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="repeat" size={24} /></div>
              <h3>母艦と再同期しています</h3>
              <progress max={progress?.total || 1} value={progress?.current ?? 0} aria-label="再同期の進捗" />
              <div className="sync-progress-numbers">
                <span>{progress?.current.toLocaleString() ?? 0} / {progress?.total.toLocaleString() ?? 0}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="sync-current-track">{progress?.trackName || "同期情報を取得しています…"}</div>
              <p>完了するまで、この画面を閉じずにお待ちください。</p>
            </section>
          )}

          {step === "resyncComplete" && resyncSummary && (
            <section className="sync-result">
              <div className="sync-result-icon success"><Icon name="check" size={26} /></div>
              <h3>再同期が完了しました</h3>
              <dl className="sync-summary sync-resync-summary">
                <div><dt>追加</dt><dd>{resyncSummary.tracksAdded.toLocaleString()} 曲</dd></div>
                <div><dt>更新</dt><dd>{resyncSummary.tracksUpdated.toLocaleString()} 曲</dd></div>
                <div><dt>エビクション候補</dt><dd>{resyncSummary.evictionCandidates.toLocaleString()} 曲</dd></div>
              </dl>
              <Failures failures={resyncSummary.failures} />
              <div className="sync-actions">
                <button className="toolbar-btn" onClick={() => setStep("manage")}>管理画面に戻る</button>
                {resyncSummary.evictionCandidates > 0 && (
                  <button className="toolbar-btn primary" onClick={loadCandidates} data-autofocus>
                    削除候補を確認
                  </button>
                )}
              </div>
            </section>
          )}

          {step === "candidates" && (
            <section>
              <h3 className="sync-section-title">削除候補</h3>
              {candidates.length > 0 ? (
                <>
                  <label className="sync-eviction-select-all">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={selectedCandidates.size === candidates.length}
                      onChange={(event) => setSelectedCandidates(event.target.checked
                        ? new Set(candidates.map((candidate) => candidate.persistentId))
                        : new Set())}
                      data-autofocus
                    />
                    すべて選択
                  </label>
                  <div className="sync-eviction-list">
                    {candidates.map((candidate) => (
                      <label className="sync-eviction-row" key={candidate.persistentId}>
                        <input
                          type="checkbox"
                          checked={selectedCandidates.has(candidate.persistentId)}
                          onChange={(event) => setSelectedCandidates((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(candidate.persistentId);
                            else next.delete(candidate.persistentId);
                            return next;
                          })}
                        />
                        <span>
                          <strong>{candidate.name || candidate.persistentId}</strong>
                          <small>{candidate.artist || "アーティスト不明"}</small>
                        </span>
                        <span>{formatBytes(candidate.bytes)}</span>
                      </label>
                    ))}
                  </div>
                  <div className="sync-selection-total" aria-live="polite">
                    <strong>{selectedCandidates.size.toLocaleString()} 曲選択</strong>
                    <span>合計 {formatBytes(selectedCandidateBytes)}</span>
                  </div>
                </>
              ) : (
                <div className="sync-empty">削除できる曲はありません。</div>
              )}
              <div className="sync-actions">
                <button className="toolbar-btn" onClick={() => setStep("manage")}>戻る</button>
                <button
                  className="toolbar-btn danger"
                  onClick={() => setStep("evictConfirm")}
                  disabled={selectedCandidates.size === 0}
                >
                  削除に進む
                </button>
              </div>
            </section>
          )}

          {step === "evictConfirm" && (
            <section className="sync-result">
              <div className="sync-result-icon error"><Icon name="warning" size={26} /></div>
              <h3>選択したファイルを削除しますか？</h3>
              <div className="sync-destructive-warning" role="alert">
                音楽ファイルがディスクから削除されます。この操作は取り消せません。
              </div>
              <dl className="sync-summary">
                <div><dt>曲数</dt><dd>{selectedCandidates.size.toLocaleString()} 曲</dd></div>
                <div><dt>対象サイズ</dt><dd>{formatBytes(selectedCandidateBytes)}</dd></div>
              </dl>
              {error && <div className="sync-error" role="alert">{error}</div>}
              <div className="sync-actions">
                <button className="toolbar-btn" onClick={() => setStep("candidates")} data-autofocus>キャンセル</button>
                <button className="toolbar-btn danger" onClick={runEviction}>削除する</button>
              </div>
            </section>
          )}

          {step === "evicting" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="trash" size={24} /></div>
              <h3>ファイルを削除しています</h3>
              <p>完了するまで、この画面を閉じずにお待ちください。</p>
            </section>
          )}

          {step === "evictComplete" && evictionSummary && (
            <section className="sync-result">
              <div className="sync-result-icon success"><Icon name="check" size={26} /></div>
              <h3>削除処理が完了しました</h3>
              <dl className="sync-summary">
                <div><dt>登録解除</dt><dd>{evictionSummary.evicted.toLocaleString()} 曲</dd></div>
                <div><dt>ファイル削除</dt><dd>{evictionSummary.filesDeleted.toLocaleString()} 件</dd></div>
                <div><dt>解放された容量</dt><dd>{formatBytes(evictionSummary.freedBytes)}</dd></div>
              </dl>
              <Failures failures={evictionSummary.failures} />
              <div className="sync-actions">
                <button className="toolbar-btn" onClick={() => void loadManagement()} data-autofocus>管理画面に戻る</button>
                <button className="toolbar-btn primary" onClick={onClose}>閉じる</button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
