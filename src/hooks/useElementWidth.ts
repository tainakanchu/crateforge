import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export interface ElementWidth<T extends HTMLElement> {
  /** 計測したい要素の `ref` に渡す (callback ref)。 */
  ref: (el: T | null) => void;
  /** 現在付いている要素 (スクロール位置の参照など、イベントハンドラから読む用)。 */
  elRef: RefObject<T | null>;
  /** 要素の内容幅 (padding を除く。ResizeObserver の contentRect.width)。未計測なら initial。 */
  width: number;
}

/**
 * 要素の内容幅を ResizeObserver で追う。
 *
 * callback ref で要素の付け替えに追従する。`useRef` + 依存 `[]` の effect だと、最初の描画で
 * 要素が無い (空状態を出している) ビューでは計測が始まらず、幅 0 のまま残る。
 */
export function useElementWidth<T extends HTMLElement = HTMLDivElement>(
  initial = 0,
): ElementWidth<T> {
  const elRef = useRef<T | null>(null);
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(initial);
  const ref = useCallback((node: T | null) => {
    elRef.current = node;
    setEl(node);
  }, []);

  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    // 初回の通知を待たずに確定させる。clientWidth は padding を含むので引いて内容幅に揃える。
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    setWidth(el.clientWidth - pad);
    return () => ro.disconnect();
  }, [el]);

  return { ref, elRef, width };
}
