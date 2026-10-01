import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import * as syncApi from "../api/sync";
import type {
  SyncProgress,
  SyncSource,
  WritebackConflict,
  WritebackPlan,
  WritebackPlaylistOp,
  WritebackResolution,
  WritebackSkippedTrack,
  WritebackSummary,
  WritebackTrackChange,
  WritebackValue,
} from "../api/sync";
import { Icon } from "./Icon";

interface SyncWritebackDialogProps {
  source: SyncSource;
  onBack: () => void;
  onClose: () => void;
  onLibraryChanged: () => void;
}

type Step = "loading" | "confirm" | "applying" | "complete" | "failed";
type ResolutionChoice = WritebackResolution["choose"];

const FIELD_LABELS: Record<string, string> = {
  rating: "レート",
  name: "曲名",
  artist: "アーティスト",
  albumArtist: "アルバムアーティスト",
  composer: "作曲者",
  album: "アルバム",
  genre: "ジャンル",
  comments: "コメント",
  year: "年",
  bpm: "BPM",
  trackNumber: "トラック番号",
  trackCount: "トラック数",
  discNumber: "ディスク番号",
  discCount: "ディスク数",
  compilation: "コンピレーション",
};

function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isStalePlanError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "stalePlan"
  );
}

function conflictKey(conflict: WritebackConflict): string {
  return `${conflict.persistentId}\u0000${conflict.field}`;
}

function formatValue(value: WritebackValue): string {
  if (value === null) return "未設定";
  if (typeof value === "boolean") return value ? "はい" : "いいえ";
  if (typeof value === "string") return value || "（空欄）";
  return value.toLocaleString("ja-JP");
}

function formatDiffValue(value: WritebackValue): string {
  if (value === null || value === "") return "（なし）";
  if (typeof value === "boolean") return value ? "はい" : "いいえ";
  if (typeof value === "string") return value;
  return value.toLocaleString("ja-JP");
}

function FieldChanges({ changes }: { changes: WritebackTrackChange[] }) {
  return (
    <ul className="writeback-track-list">
      {changes.map((change) => (
        <li key={change.persistentId} className="writeback-track">
          <strong>{change.trackName || change.persistentId}</strong>
          <ul>
            {change.fields.map((update) => (
              <li key={update.field}>
                <span>{FIELD_LABELS[update.field] ?? update.field}</span>
                <span className="writeback-field-value">
                  {formatDiffValue(update.previous)} → {formatDiffValue(update.value)}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function playlistOpLabel(op: WritebackPlaylistOp): string {
  switch (op.op) {
    case "create":
      return "作成";
    case "rename":
      return "リネーム";
    case "replaceTracks":
      return "並び順を置換";
    case "skippedDelete":
      return "削除をスキップ";
    case "skippedConflict":
      return "反映をスキップ";
  }
}

function PlaylistOperation({ op }: { op: WritebackPlaylistOp }) {
  let detail: string;
  switch (op.op) {
    case "create":
      detail = `${op.name}（${op.trackPersistentIds.length.toLocaleString()} 曲）`;
      break;
    case "rename":
      detail = `${op.from} → ${op.to}`;
      break;
    case "replaceTracks":
      detail = `${op.name}（${op.trackPersistentIds.length.toLocaleString()} 曲）`;
      break;
    case "skippedDelete":
      detail = `${op.name} — ${op.reason}`;
      break;
    case "skippedConflict":
      detail = `${op.name} — ${op.reason}`;
      break;
  }

  return (
    <li className={`writeback-playlist-op ${op.op}`}>
      <span className="writeback-op-label">{playlistOpLabel(op)}</span>
      <span className="writeback-op-detail">{detail}</span>
      {op.op === "replaceTracks" && op.overwritesMasterOrdering && (
        <span className="writeback-order-warning">
          <Icon name="info" size={13} /> 母艦側の現在の並び順を上書きします
        </span>
      )}
    </li>
  );
}

function SkippedTracks({ skipped }: { skipped: WritebackSkippedTrack[] }) {
  return (
    <ul className="writeback-track-list">
      {skipped.map((skip) => (
        <li key={skip.persistentId} className="writeback-skipped-track">
          <strong>{skip.trackName || skip.persistentId}</strong>
          <span>{skip.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function SyncWritebackDialog({
  source,
  onBack,
  onClose,
  onLibraryChanged,
}: SyncWritebackDialogProps) {
  const [step, setStep] = useState<Step>("loading");
  const [plan, setPlan] = useState<WritebackPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ResolutionChoice>>({});
  const [progress, setProgress] = useState<SyncProgress | null>({
    phase: "writebackPlanning",
    current: 0,
    total: 1,
    trackName: null,
  });
  const [summary, setSummary] = useState<WritebackSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const completeHandledRef = useRef(false);
  const isApplying = step === "applying";

  const finishApply = useCallback(
    (result: WritebackSummary) => {
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
        if (
          nextProgress.phase === "writebackPlanning" ||
          nextProgress.phase === "writebackApplying"
        ) {
          setProgress(nextProgress);
        }
      }),
      syncApi.onWritebackComplete(finishApply),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((unlisten) => unlisten());
      else unlisteners = listeners;
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [finishApply]);

  const loadPlan = useCallback(async () => {
    setStep("loading");
    setPlan(null);
    setError(null);
    setProgress({
      phase: "writebackPlanning",
      current: 0,
      total: 1,
      trackName: null,
    });
    try {
      const result = await syncApi.syncWritebackPlan(source.id);
      const defaults = Object.fromEntries(
        result.conflicts.map((conflict) => [
          conflictKey(conflict),
          conflict.localNewer ? "local" : "master",
        ]),
      ) as Record<string, ResolutionChoice>;
      setPlan(result);
      setResolutions(defaults);
      setProgress(null);
      setStep("confirm");
    } catch (planError) {
      setError(`書き戻す内容を確認できませんでした: ${errorMessage(planError)}`);
      setProgress(null);
      setStep("failed");
    }
  }, [source.id]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        if (!isApplying) {
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
    [isApplying, onClose],
  );

  const startApply = useCallback(async () => {
    if (!plan || isApplying) return;
    completeHandledRef.current = false;
    setSummary(null);
    setError(null);
    setProgress({
      phase: "writebackApplying",
      current: 0,
      total:
        plan.trackChanges.length + plan.pulls.length + plan.playlistOps.length,
      trackName: null,
    });
    setStep("applying");
    const selected = plan.conflicts.map<WritebackResolution>((conflict) => ({
      persistentId: conflict.persistentId,
      field: conflict.field,
      choose:
        resolutions[conflictKey(conflict)] ??
        (conflict.localNewer ? "local" : "master"),
    }));
    try {
      const result = await syncApi.syncWritebackApply(source.id, plan.planId, selected);
      finishApply(result);
    } catch (applyError) {
      if (isStalePlanError(applyError)) {
        setProgress({
          phase: "writebackPlanning",
          current: 0,
          total: 1,
          trackName: null,
        });
        try {
          const refreshed = await syncApi.syncWritebackPlan(source.id);
          setPlan(refreshed);
          setResolutions(
            Object.fromEntries(
              refreshed.conflicts.map((conflict) => [
                conflictKey(conflict),
                conflict.localNewer ? "local" : "master",
              ]),
            ) as Record<string, ResolutionChoice>,
          );
          setError("母艦または手元の状態が変わりました。更新後の内容を確認してください。");
          setProgress(null);
          setStep("confirm");
          return;
        } catch (planError) {
          setError(`更新後の内容を確認できませんでした: ${errorMessage(planError)}`);
          setProgress(null);
          setStep("failed");
          return;
        }
      }
      setError(`書き戻しに失敗しました: ${errorMessage(applyError)}`);
      setProgress(null);
      setStep("failed");
    }
  }, [finishApply, isApplying, plan, resolutions, source.id]);

  // skippedConflict は「反映しない」ことの通知であって適用可能な変更ではないため、
  // 適用ボタンの表示可否はこれを除いた項目の有無で判定する。
  const hasApplicableChanges = useMemo(
    () =>
      !!plan &&
      (plan.trackChanges.length > 0 ||
        plan.pulls.length > 0 ||
        plan.conflicts.length > 0 ||
        plan.playlistOps.some((op) => op.op !== "skippedConflict")),
    [plan],
  );
  const skippedConflictCount = useMemo(
    () => plan?.playlistOps.filter((op) => op.op === "skippedConflict").length ?? 0,
    [plan],
  );
  const skippedNoticeCount = (plan?.skippedTracks.length ?? 0) + skippedConflictCount;
  const hasSkippedNotices = skippedNoticeCount > 0;
  // 適用可能な変更が無くても、スキップの通知だけは見せる必要がある。
  const hasPlanItems = hasApplicableChanges || hasSkippedNotices;
  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;
  const sourceName = source.name?.trim() || source.baseUrl;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isApplying) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal sync-modal writeback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="writeback-dialog-title"
        tabIndex={-1}
        onKeyDownCapture={handleDialogKeyDown}
      >
        <div className="modal-header">
          <h2 id="writeback-dialog-title">
            <Icon name="upload" size={16} /> 母艦へ書き戻す
          </h2>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={isApplying}
            aria-label="閉じる"
            title={isApplying ? "書き戻し中は閉じられません" : "閉じる (Esc)"}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body sync-body">
          {step === "loading" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="upload" size={24} /></div>
              <h3>書き戻す内容を確認しています</h3>
              <progress
                max={progress?.total || 1}
                value={progress?.current ?? 0}
                aria-label="書き戻し計画の進捗"
              />
              <div className="sync-progress-numbers">
                <span>{progress?.current.toLocaleString() ?? 0} / {progress?.total.toLocaleString() ?? 1}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="sync-current-track">{sourceName}</div>
              <p>母艦と手元の変更内容を比較しています。</p>
            </section>
          )}

          {step === "confirm" && plan && (
            <section>
              {error && (
                <div className="sync-error" role="status">
                  {error}
                </div>
              )}
              <div className="sync-playlist-heading">
                <div>
                  <h3 className="sync-section-title">書き戻す内容を確認</h3>
                  <span>{sourceName}</span>
                </div>
                <button className="rip-link" type="button" onClick={onBack}>
                  接続先を変更
                </button>
              </div>

              {!hasPlanItems ? (
                <div className="writeback-empty">
                  <div className="sync-result-icon success"><Icon name="check" size={24} /></div>
                  <strong>書き戻す変更はありません</strong>
                  <span>母艦と手元の内容は同期されています。</span>
                </div>
              ) : (
                <div className="writeback-plan">
                  {!hasApplicableChanges && (
                    <div className="writeback-skip-notice" role="status">
                      <Icon name="warning" size={16} />
                      <div>
                        <strong>
                          反映できる変更はありません（スキップ {skippedNoticeCount.toLocaleString()} 件あり）
                        </strong>
                        <span>
                          母艦側の変更と競合、または母艦から曲が消えているため、以下の内容は今回反映されません。
                        </span>
                      </div>
                    </div>
                  )}

                  {plan.trackChanges.length > 0 && (
                    <section className="writeback-section">
                      <h4>母艦へ反映される変更</h4>
                      <FieldChanges changes={plan.trackChanges} />
                    </section>
                  )}

                  {plan.pulls.length > 0 && (
                    <section className="writeback-section">
                      <h4>手元へ取り込まれる変更</h4>
                      <FieldChanges changes={plan.pulls} />
                    </section>
                  )}

                  {plan.playlistOps.length > 0 && (
                    <section className="writeback-section">
                      <h4>プレイリスト操作</h4>
                      <ul className="writeback-playlist-list">
                        {plan.playlistOps.map((op, index) => (
                          <PlaylistOperation key={`${op.persistentId}-${op.op}-${index}`} op={op} />
                        ))}
                      </ul>
                    </section>
                  )}

                  {plan.conflicts.length > 0 && (
                    <section className="writeback-section writeback-conflicts">
                      <h4>衝突</h4>
                      <p>両方で変更された項目です。書き戻し後に残す値を選んでください。</p>
                      <ul>
                        {plan.conflicts.map((conflict, index) => {
                          const key = conflictKey(conflict);
                          const choice = resolutions[key];
                          // rating など時計が動かない項目では新旧を判定できない。
                          // 判定できたときだけ「新しい」と表示する (localNewer は既定の選択)。
                          const newerKnown = conflict.newerKnown;
                          return (
                            <li key={key} className="writeback-conflict">
                              <div className="writeback-conflict-heading">
                                <strong>{conflict.trackName || conflict.persistentId}</strong>
                                <span>{FIELD_LABELS[conflict.field] ?? conflict.field}</span>
                              </div>
                              <div className="writeback-choice" role="radiogroup">
                                <label className={choice === "master" ? "selected" : undefined}>
                                  <input
                                    type="radio"
                                    name={`writeback-conflict-${index}`}
                                    value="master"
                                    checked={choice === "master"}
                                    onChange={() =>
                                      setResolutions((current) => ({ ...current, [key]: "master" }))
                                    }
                                  />
                                  <span>
                                    <small>
                                      母艦の値{newerKnown && !conflict.localNewer ? "（新しい）" : ""}
                                    </small>
                                    <strong>{formatValue(conflict.master)}</strong>
                                  </span>
                                </label>
                                <label className={choice === "local" ? "selected" : undefined}>
                                  <input
                                    type="radio"
                                    name={`writeback-conflict-${index}`}
                                    value="local"
                                    checked={choice === "local"}
                                    onChange={() =>
                                      setResolutions((current) => ({ ...current, [key]: "local" }))
                                    }
                                  />
                                  <span>
                                    <small>
                                      持ち出しの値{newerKnown && conflict.localNewer ? "（新しい）" : ""}
                                    </small>
                                    <strong>{formatValue(conflict.local)}</strong>
                                  </span>
                                </label>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  )}

                  {plan.skippedTracks.length > 0 && (
                    <section className="writeback-section writeback-skipped">
                      <h4>反映されない変更</h4>
                      <SkippedTracks skipped={plan.skippedTracks} />
                    </section>
                  )}
                </div>
              )}
            </section>
          )}

          {step === "applying" && (
            <section className="sync-progress-view" aria-live="polite">
              <div className="sync-progress-icon"><Icon name="upload" size={24} /></div>
              <h3>母艦へ書き戻しています</h3>
              <progress
                max={progress?.total || 1}
                value={progress?.current ?? 0}
                aria-label="書き戻しの進捗"
              />
              <div className="sync-progress-numbers">
                <span>{progress?.current.toLocaleString() ?? 0} / {progress?.total.toLocaleString() ?? 0}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="sync-current-track">
                {progress?.trackName || "変更を適用しています…"}
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
                  ? `書き戻しが完了しました（${summary.failures.length.toLocaleString()} 件の失敗あり）`
                  : "書き戻しが完了しました"}
              </h3>
              <dl className="sync-summary">
                <div><dt>母艦へ反映</dt><dd>{summary.pushed.toLocaleString()} 曲</dd></div>
                <div><dt>手元へ取り込み</dt><dd>{summary.pulled.toLocaleString()} 曲</dd></div>
                <div><dt>プレイリスト操作</dt><dd>{summary.playlistOps.toLocaleString()} 件</dd></div>
              </dl>
              {summary.failures.length > 0 && (
                <details className="sync-failures" open>
                  <summary>失敗一覧（{summary.failures.length.toLocaleString()} 件）</summary>
                  <ul>
                    {summary.failures.map((failure, index) => (
                      <li key={`${failure.persistentId ?? "failure"}-${index}`}>
                        <strong>{failure.trackName || failure.persistentId || "不明な項目"}</strong>
                        <span>{failure.error}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}

          {step === "failed" && (
            <section className="sync-result">
              <div className="sync-result-icon error"><Icon name="x" size={26} /></div>
              <h3>{plan ? "書き戻しに失敗しました" : "内容を確認できませんでした"}</h3>
              <div className="sync-error" role="alert">
                {error || "不明なエラーが発生しました。"}
              </div>
            </section>
          )}
        </div>

        {step === "confirm" && plan && (
          <div className="modal-footer">
            <button className="toolbar-btn" type="button" onClick={onBack} data-autofocus>
              戻る
            </button>
            {hasApplicableChanges && (
              <button className="toolbar-btn primary" type="button" onClick={startApply}>
                <Icon name="upload" size={14} /> この内容で書き戻す
              </button>
            )}
          </div>
        )}
        {step === "complete" && summary && (
          <div className="modal-footer">
            <button className="toolbar-btn primary" onClick={onClose} data-autofocus>
              閉じる
            </button>
          </div>
        )}
        {step === "failed" && (
          <div className="modal-footer">
            <button className="toolbar-btn" onClick={onBack}>
              接続先に戻る
            </button>
            {plan ? (
              <button className="toolbar-btn primary" onClick={() => setStep("confirm")} data-autofocus>
                確認画面に戻る
              </button>
            ) : (
              <button className="toolbar-btn primary" onClick={loadPlan} data-autofocus>
                再試行
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
