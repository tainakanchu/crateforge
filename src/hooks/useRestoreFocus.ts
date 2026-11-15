import { useEffect } from "react";

/**
 * マウント時にフォーカスがあった要素を覚えておき、アンマウント時にそこへ戻す
 * (ダイアログを閉じたら、開いたボタンへフォーカスが戻るように)。
 */
export function useRestoreFocus(): void {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus();
  }, []);
}
