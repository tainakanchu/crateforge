import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Virtualizer } from "@tanstack/react-virtual";
import { GRID_EXPAND_ESTIMATE, remeasureGridRows, shouldRemeasureGrid } from "../lib/gridRows";
import type { GridMeasureKey, GridRow } from "../lib/gridRows";

interface CardGridVirtualizerOptions<T> {
  rows: GridRow<T>[];
  /** スクロール要素。仮想行 (`data-index` 付き) はその直下のラッパ div の子に置くこと。 */
  scrollRef: RefObject<HTMLElement | null>;
  cols: number;
  /** グリッド行 1 行の高さの見積もり (カード幅 + ラベル + 行間)。 */
  gridRowHeight: number;
}

/**
 * カードグリッドの行仮想化 (`buildGridRows` の行を縦に並べる)。
 *
 * - 行キーは `GridRow.key` (安定キー)。展開の開閉では実測キャッシュを捨てない
 *   (捨てると展開行が見積もり高さに戻り、次の行が重なって描画される)。
 * - カード幅/列数が変わるとグリッド行の高さが変わるので、そのときだけ実測キャッシュを捨てる。
 *   `measure()` はキャッシュを消すだけで再計測しないため、表示中の行はその場で測り直す
 *   (手順と理由は remeasureGridRows)。
 */
export function useCardGridVirtualizer<T>({
  rows,
  scrollRef,
  cols,
  gridRowHeight,
}: CardGridVirtualizerOptions<T>): Virtualizer<HTMLElement, Element> {
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "expand" ? GRID_EXPAND_ESTIMATE : gridRowHeight),
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
    const rendered = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>(":scope > div > [data-index]") ?? [],
      (el) => ({ index: Number(el.dataset.index), size: el.offsetHeight }),
    );
    remeasureGridRows(virtualizer, rendered);
  });

  return virtualizer;
}
