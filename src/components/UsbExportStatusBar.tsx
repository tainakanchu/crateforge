import { useStore } from "../store/useStore";
import { usbOverallFraction, usbPhaseLabel } from "../lib/usbExport";
import { Icon } from "./Icon";

interface UsbExportStatusBarProps {
  /** ダイアログが開いている間は出さない。 */
  hidden: boolean;
  onOpen: () => void;
}

/**
 * USB 書き出しの浮遊進捗カード (RipStatusBar と同じ見た目)。ダイアログを閉じても書き出しは
 * 続くので、右下に出してクリックでダイアログへ戻れるようにする。CD 取り込みのカードと
 * 重ならないよう、そちらが出ているときは一段上に積む。
 */
export function UsbExportStatusBar({ hidden, onOpen }: UsbExportStatusBarProps) {
  const status = useStore((s) => s.usbExportStatus);
  const ripVisible = useStore((s) => s.ripStatus != null);
  const clear = useStore((s) => s.setUsbExportStatus);
  if (!status || hidden) return null;

  const pct = Math.round(usbOverallFraction(status) * 100);
  const phaseClass =
    status.phase === "done" ? "done" : status.phase === "error" ? "error" : "running";
  let title: string;
  let detail: string;
  if (status.phase === "running") {
    title = status.cancelling ? "USB 書き出しを中止中…" : "USB に書き出し中";
    detail = `${usbPhaseLabel(status.stage)}${status.title ? ` — ${status.title}` : ""}`;
  } else if (status.phase === "done") {
    title = "USB 書き出し完了";
    const r = status.result;
    detail = r ? `${r.tracks.exported} 曲（コピー ${r.tracks.copied}）` : "";
  } else {
    title =
      status.error?.code === "cancelled" ? "USB 書き出しを中止しました" : "USB 書き出し失敗";
    detail = status.error?.message ?? "";
  }

  return (
    <div
      className={`rip-status-bar rip-status-bar--${phaseClass} usb-status-bar${ripVisible ? " usb-status-bar--stacked" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title="クリックして詳細を表示"
      aria-label={`${title}（Enter で詳細を表示）`}
    >
      <div className="rip-status-bar__head">
        <Icon
          name={
            status.phase === "done" ? "checkCircle" : status.phase === "error" ? "xCircle" : "upload"
          }
          size={14}
        />
        <span className="rip-status-bar__title">{title}</span>
        {status.phase === "running" && status.total > 0 && (
          <span className="rip-status-bar__count">
            {status.current}/{status.total}
          </span>
        )}
        {status.phase === "running" && <span className="rip-status-bar__pct">{pct}%</span>}
        {status.phase !== "running" && (
          <button
            className="rip-status-bar__close"
            onClick={(e) => {
              e.stopPropagation();
              clear(null);
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
      </div>
    </div>
  );
}
