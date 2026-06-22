import { useEffect } from "react";
import { useStore } from "../store/useStore";
import type { Toast } from "../store/useStore";

/**
 * グローバルトーストの表示領域。`useStore().pushToast(kind, message)` で出す。
 * 右下に積み上げ表示し、各トーストは durationMs 後に自動で消える。
 */
export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" role="region" aria-label="通知" aria-live="polite">
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
