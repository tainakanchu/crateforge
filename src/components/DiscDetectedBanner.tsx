import type { DiscToc } from "../types";

interface DiscDetectedBannerProps {
  disc: DiscToc;
  onRip: () => void;
  onDismiss: () => void;
}

export function DiscDetectedBanner({ disc: _disc, onRip, onDismiss }: DiscDetectedBannerProps) {
  return (
    <div className="disc-detected-banner">
      <span>💿</span>
      <span className="disc-detected-banner-text">
        CD を検出しました — 取り込みますか？
      </span>
      <button className="toolbar-btn primary" onClick={onRip}>
        取り込む
      </button>
      <button className="toolbar-btn" onClick={onDismiss}>
        閉じる
      </button>
    </div>
  );
}
