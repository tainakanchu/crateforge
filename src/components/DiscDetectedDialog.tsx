import { useEffect } from "react";
import type { DiscToc } from "../types";
import { Icon } from "./Icon";

interface DiscDetectedDialogProps {
  disc: DiscToc;
  onRip: () => void;
  onDismiss: () => void;
}

function formatTotal(sec: number): string {
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * CD 挿入を検出したときの確認ダイアログ（issue #219）。
 *
 * 以前は `.app` (grid) 直下にバナーとして置いていたため、配置指定のない
 * grid アイテムとして暗黙のセルに押し込まれ、レイアウトが崩れていた。
 * 他のダイアログと同じく `.modal-overlay` で画面中央に出す。
 */
export function DiscDetectedDialog({ disc, onRip, onDismiss }: DiscDetectedDialogProps) {
  const totalSec = disc.trackLengthsSec.reduce((a, b) => a + b, 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div
        className="modal"
        style={{ width: 380 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="disc-detected-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="disc-detected-title">
            <Icon name="disc" size={16} /> CD を検出しました
          </h2>
          <button className="modal-close" onClick={onDismiss} aria-label="閉じる">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div
          className="modal-body"
          style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div>このディスクを取り込みますか？</div>
          <div style={{ fontSize: 12, color: "var(--mut)" }}>
            {disc.trackCount} トラック
            {totalSec > 0 && ` / ${formatTotal(totalSec)}`}
            {" · "}
            {disc.device}
          </div>
        </div>
        <div className="modal-footer">
          <button className="toolbar-btn" onClick={onDismiss}>
            閉じる
          </button>
          <button className="toolbar-btn primary" onClick={onRip}>
            取り込む
          </button>
        </div>
      </div>
    </div>
  );
}
