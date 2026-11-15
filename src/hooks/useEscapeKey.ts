import { useEffect } from "react";

interface EscapeKeyOptions {
  /** false の間は購読しない (処理中は閉じさせない、など)。既定 true。 */
  enabled?: boolean;
  /** Esc を処理したとき preventDefault するか。既定 true。 */
  preventDefault?: boolean;
}

/**
 * Esc が押されたら onEscape を呼ぶ (window の keydown・バブリング段階)。
 *
 * 他の Esc ハンドラとの優先順位 (`defaultPrevented` を見る、capture で先取りする、
 * 入力欄の Esc を先に処理する等) が要るダイアログは、この hook を使わず自前で購読する。
 */
export function useEscapeKey(onEscape: () => void, options: EscapeKeyOptions = {}): void {
  const { enabled = true, preventDefault = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (preventDefault) e.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape, enabled, preventDefault]);
}
