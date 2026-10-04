import { useEffect } from "react";
import { useStore, type RipStatus } from "../store/useStore";
import { playRipChime } from "../lib/ripChime";
import { Icon } from "./Icon";

interface RipStatusBarProps {
  onOpenLog: () => void;
}

/** 全体進捗 (0〜1)。完了済みトラック数 + 現在トラックの進捗割合 を総数で割る。 */
function ripOverallFraction(s: RipStatus): number {
  if (s.phase === "done") return 1;
  if (s.total <= 0) return 0;
  const completed = Math.max(0, s.current - 1);
  const frac = s.current > 0 ? Math.min(100, Math.max(0, s.percent ?? 0)) / 100 : 0;
  return Math.min(1, (completed + frac) / s.total);
}

const STAGE_LABEL = {
  reading: "読み取り中",
  encoding: "エンコード中",
} as const;

/**
 * 完了 / 失敗に切り替わった瞬間に通知音を鳴らす。
 * done はイベント購読 (App)、error は ripCd の catch (RipDialog) と出どころが別なので、
 * ストアの phase 遷移を見て一か所で判定する。
 */
function useRipCompletionSound() {
  useEffect(
    () =>
      useStore.subscribe((state, prev) => {
        const phase = state.ripStatus?.phase;
        if (phase !== "done" && phase !== "error") return;
        if (prev.ripStatus?.phase === phase) return;
        if (!state.ripSoundEnabled) return;
        playRipChime(phase);
      }),
    [],
  );
}

/**
 * CD 取り込みの進捗カード。右ペインの有無に関係なく、プレーヤーバーの上・右下に浮かせて表示する。
 * クリック / Enter でログ (RipDialog) を開く。完了・失敗時は × で閉じられる。
 */
export function RipStatusBar({ onOpenLog }: RipStatusBarProps) {
  const ripStatus = useStore((s) => s.ripStatus);
  const clearRipStatus = useStore((s) => s.clearRipStatus);
  useRipCompletionSound();

  if (!ripStatus) return null;

  const { phase, current, total, label, stage, addedTracks, error } = ripStatus;
  const pct = Math.round(ripOverallFraction(ripStatus) * 100);
  const shownCurrent = phase === "done" ? total : current;

  let title: string;
  let detail: string;
  if (phase === "ripping") {
    title = "CD 取り込み中";
    detail = current > 0 ? label : "準備中…";
  } else if (phase === "done") {
    title = "CD 取り込み完了";
    detail = `${addedTracks ?? 0} 曲をライブラリに追加しました`;
  } else {
    title = "CD 取り込み失敗";
    detail = error ?? "";
  }

  return (
    <div
      className={`rip-status-bar rip-status-bar--${phase}`}
      role="button"
      tabIndex={0}
      onClick={onOpenLog}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenLog();
        }
      }}
      title="クリックしてログを表示"
      aria-label={`${title}${total > 0 ? ` ${shownCurrent}/${total}` : ""}（Enter でログを表示）`}
    >
      <div className="rip-status-bar__head">
        <Icon
          name={phase === "done" ? "checkCircle" : phase === "error" ? "xCircle" : "disc"}
          size={14}
        />
        <span className="rip-status-bar__title">{title}</span>
        {total > 0 && (
          <span className="rip-status-bar__count">
            {shownCurrent}/{total}
          </span>
        )}
        {phase === "ripping" && <span className="rip-status-bar__pct">{pct}%</span>}
        {phase !== "ripping" && (
          <button
            className="rip-status-bar__close"
            onClick={(e) => {
              e.stopPropagation();
              clearRipStatus();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title="閉じる"
            aria-label="閉じる"
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <div
        className="rip-status-bar__track"
        role="progressbar"
        aria-label="全体の進捗"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="rip-status-bar__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="rip-status-bar__sub">
        <span className="rip-status-bar__label" title={detail}>
          {detail}
        </span>
        {phase === "ripping" && stage && current > 0 && (
          <span className={`rip-status-bar__stage rip-status-bar__stage--${stage}`}>
            {STAGE_LABEL[stage]}
          </span>
        )}
      </div>
    </div>
  );
}
