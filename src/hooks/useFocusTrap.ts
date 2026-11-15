import { useCallback, useEffect } from "react";
import type { DependencyList, RefObject } from "react";
import { FOCUSABLE_SELECTOR, TRAP_CONTAINER, nextTrapFocus } from "../lib/focusTrap";

interface TabKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
}

/**
 * ダイアログ内で Tab を循環させる keydown ハンドラを返す (Tab 以外のキーは何もしない)。
 *
 * Esc や stopPropagation の扱いはダイアログごとに違うので呼び出し元の keydown に残し、
 * その末尾からこのハンドラを呼ぶ。
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
): (event: TabKeyEvent) => void {
  return useCallback(
    (event: TabKeyEvent) => {
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      const focusable = Array.from(
        container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      );
      const target = nextTrapFocus(
        focusable,
        document.activeElement as HTMLElement | null,
        event.shiftKey,
      );
      if (target === null) return;
      event.preventDefault();
      if (target === TRAP_CONTAINER) container?.focus();
      else target.focus();
    },
    [containerRef],
  );
}

/**
 * ダイアログの表示内容が切り替わるたびに、`data-autofocus` の付いた要素 (無ければ
 * ダイアログ本体) へフォーカスを移す。deps には切り替わりのきっかけ (step など) を並べる。
 */
export function useDialogAutoFocus(
  containerRef: RefObject<HTMLElement | null>,
  deps: DependencyList,
): void {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const target = containerRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      (target ?? containerRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
