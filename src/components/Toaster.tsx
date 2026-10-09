import { useEffect } from "react";
import { useStore } from "../store/useStore";
import type { Toast } from "../store/useStore";

/**
 * グローバルトーストの表示領域。`useStore().pushToast(kind, message)` で出す。
 * 右下に積み上げ表示し、各トーストは durationMs 後に自動で消える。
 */
export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  // CD 取り込みの進捗カード (RipStatusBar) と同じ右下に出るので、表示中はその上へずらす。
  const ripVisible = useStore((s) => s.ripStatus !== null);
  // USB 書き出しの進捗カードも同じ位置に出る (両方出ていればさらに一段上へ)。
  const usbVisible = useStore((s) => s.usbExportStatus !== null);
  const cards = (ripVisible ? 1 : 0) + (usbVisible ? 1 : 0);
  if (toasts.length === 0) return null;
  return (
    <div
      className={
        "toaster" +
        (cards >= 1 ? " toaster--above-rip" : "") +
        (cards >= 2 ? " toaster--above-two" : "")
      }
      role="region"
      aria-label="通知"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismissToast = useStore((s) => s.dismissToast);
  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const id = setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => clearTimeout(id);
  }, [toast.id, toast.durationMs, dismissToast]);

  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-msg">{toast.message}</span>
      <button
        className="toast-close"
        onClick={() => dismissToast(toast.id)}
        aria-label="閉じる"
        title="閉じる"
      >
        ×
      </button>
    </div>
  );
}
