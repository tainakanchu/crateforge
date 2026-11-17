import { useCallback, useEffect, useState } from "react";
import { relocateExpanded } from "../lib/gridRows";
import type { GridExpanded } from "../lib/gridRows";
import type { WindowedList } from "./useWindowedList";

/** 展開中の項目。位置 (通し番号) と、展開行を描くための項目そのものを覚える。 */
export type ExpandedItem<T> = GridExpanded & { item: T };

/**
 * カードグリッドの「展開中の項目」 (AlbumsView / ArtistsView 共通。docs/library-list/design.md §6)。
 *
 * - 展開は「項目キー + 開いたときの通し番号」で覚え、展開行を描けるよう項目そのものも持つ
 *   (スクロールしてそのページがキャッシュから外れても、展開行は描ける)。
 * - 一覧が切り替わったら (key の変化) 閉じる。
 * - 一覧を取り直して位置がずれたら、取得済みの項目から同じキーを探して合わせ直す。
 *   一覧から無くなっていたら閉じる。
 */
export function useGridExpansion<T>(list: WindowedList<T>, keyOf: (item: T) => string) {
  const [expanded, setExpanded] = useState<ExpandedItem<T> | null>(null);

  useEffect(() => {
    setExpanded(null);
  }, [list.key]);

  useEffect(() => {
    setExpanded((prev) => {
      if (!prev) return prev;
      const loadedKeys = (function* (): IterableIterator<[number, string]> {
        for (const [i, item] of list.loaded()) yield [i, keyOf(item)];
      })();
      const next = relocateExpanded(
        prev,
        list.count,
        (i) => {
          const item = list.get(i);
          return item === undefined ? undefined : keyOf(item);
        },
        loadedKeys,
      );
      if (!next) return null;
      const item = list.get(next.index) ?? prev.item;
      return next === prev && item === prev.item ? prev : { ...next, item };
    });
  }, [list, keyOf]);

  /** カードの開閉。index はカードの通し番号 (展開行を差し込む位置)。開いたら true を返す。 */
  const toggle = useCallback(
    (item: T, index: number): boolean => {
      const key = keyOf(item);
      const willOpen = expanded?.key !== key;
      setExpanded(willOpen ? { key, index, item } : null);
      return willOpen;
    },
    [expanded, keyOf],
  );

  const close = useCallback(() => setExpanded(null), []);

  return { expanded, toggle, close };
}
