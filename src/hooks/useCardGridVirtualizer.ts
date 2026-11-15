import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Virtualizer } from "@tanstack/react-virtual";
import { GRID_EXPAND_ESTIMATE, shouldRemeasureGrid } from "../lib/gridRows";
import type { GridLayout, GridMeasureKey } from "../lib/gridRows";

interface CardGridVirtualizerOptions {
  /** 行の並び (`gridLayout`)。件数ぶんの行を最初から確保する。 */
  layout: GridLayout;
  /** スクロール要素。仮想行 (`data-index` 付き) はその直下のラッパ div の子に置くこと。 */
  scrollRef: RefObject<HTMLElement | null>;
  /** グリッド行 1 行の高さの見積もり (カード幅 + ラベル + 行間)。 */
  gridRowHeight: number;
  /**
   * 描画する行に並ぶ項目の通し番号の範囲 (両端を含む) を伝える。ウィンドウ取得
   * (`useWindowedList` の `setVisibleRange`) へそのまま渡す。
   */
  onVisibleItems?: (start: number, end: number) => void;
}

/**
 * カードグリッドの行仮想化 (`gridLayout` の行を縦に並べる)。
 *
 * - 行キーは `GridRow.key` (安定キー)。展開の開閉では実測キャッシュを捨てない
 *   (捨てると展開行が見積もり高さに戻り、次の行が重なって描画される)。
 * - カード幅/列数が変わるとグリッド行の高さが変わるので、そのときだけ実測キャッシュを捨てる。
 *   `measure()` はキャッシュを消すだけで再計測しないため、表示中の行はその場で測り直す。
 */
export function useCardGridVirtualizer({
  layout,
  scrollRef,
  gridRowHeight,
  onVisibleItems,
}: CardGridVirtualizerOptions): Virtualizer<HTMLElement, Element> {
  const { cols } = layout;
  const getItemKey = useCallback((i: number) => layout.rowAt(i).key, [layout]);
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: layout.rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) =>
      layout.rowAt(i).type === "expand" ? GRID_EXPAND_ESTIMATE : gridRowHeight,
    getItemKey,
    overscan: 6,
    paddingStart: 18,
    paddingEnd: 18,
  });

  // 測り直すかどうかの判定は shouldRemeasureGrid (純関数・テストあり) に置く。
  // 毎レンダー後に判定だけ行い、行リストや展開状態の変化では測り直さない。
  const measuredRef = useRef<GridMeasureKey | null>(null);
  useLayoutEffect(() => {
    const next: GridMeasureKey = { gridRowHeight, cols };
    if (!shouldRemeasureGrid(measuredRef.current, next)) return;
    measuredRef.current = next;
    virtualizer.measure();
    scrollRef.current
      ?.querySelectorAll<HTMLElement>(":scope > div > [data-index]")
      .forEach((el) => virtualizer.measureElement(el));
  });

  // 描画する行 (overscan を含む) の項目の範囲を毎レンダー後に伝える。同じ範囲なら受け手が無視する。
  const virtualItems = virtualizer.getVirtualItems();
  const firstRow = virtualItems.length > 0 ? virtualItems[0].index : -1;
  const lastRow = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (!onVisibleItems || firstRow < 0) return;
    const range = layout.itemRange(firstRow, lastRow);
    if (range) onVisibleItems(range.start, range.end);
  }, [onVisibleItems, layout, firstRow, lastRow]);

  return virtualizer;
}
