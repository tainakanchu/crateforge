import { useStore } from "../store/useStore";
import { Icon } from "./Icon";

interface RipStatusBarProps {
  onOpenLog: () => void;
}

export function RipStatusBar({ onOpenLog }: RipStatusBarProps) {
  const ripStatus = useStore((s) => s.ripStatus);
  const clearRipStatus = useStore((s) => s.clearRipStatus);

  if (!ripStatus) return null;

  const { phase, current, total, label, percent, addedTracks, error } = ripStatus;

  let text: string;
  if (phase === "ripping") {
    text = `リッピング中 ${current}/${total}${label ? ` ▸ ${label}` : ""}${percent != null ? ` (${percent}%)` : ""}`;
  } else if (phase === "done") {
    text = `リッピング完了: ${addedTracks ?? 0} 曲`;
  } else {
    text = `リッピング失敗${error ? `: ${error}` : ""}`;
  }

  return (
    <div
      className={`rip-status-bar rip-status-bar--${phase}`}
      onClick={onOpenLog}
      title="クリックしてログを表示"
    >
      <span className="rip-status-bar__text">{text}</span>
      {phase !== "ripping" && (
        <button
          className="rip-status-bar__close"
          onClick={(e) => {
            e.stopPropagation();
            clearRipStatus();
          }}
          title="閉じる"
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}
