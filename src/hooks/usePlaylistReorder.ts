import { useCallback, useEffect, useRef, useState } from "react";
import * as playlistsApi from "../api/playlists";
import { useStore } from "../store/useStore";
import { anchorsForDrop, moveIdsWithin } from "../lib/trackDrag";
import type { TrackList } from "./useTrackList";

/** 最後の並べ替え操作から DB へ書き込むまでの待ち時間 (ms)。連続操作を 1 回の書き込みにまとめる。 */
const WRITE_DELAY_MS = 300;

interface PlaylistReorderOptions {
  list: TrackList;
  /** 並べ替えできる状態か (通常プレイリストを手動順・検索なしで表示している)。 */
  enabled: boolean;
  playlistId: number | null;
  /** 書き込みが終わったあと (一覧を取り直す)。 */
  onWritten: () => void;
  /** 行番号の行が見えるようにスクロールする。 */
  scrollToIndex: (index: number) => void;
}

interface Pending {
  playlistId: number;
  /** 操作を始めたときの全曲順 (書き込みの直前に、DB がこの並びのままか確かめる)。 */
  base: readonly number[];
  /** いま画面に見せている並び (これを書き込む)。 */
  order: number[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

const sameOrder = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * プレイリストの手動並べ替え (行のドラッグ / Alt+↑↓)。docs/library-list/design.md §5。
 *
 * - **すぐ見せる**: 操作のたびに、画面の並びを先に入れ替える (取得済みの行を並べ替えるだけ)。
 * - **まとめて書く**: 連続した操作は最後の操作から少し待って 1 回で書き込む。
 *   `reorder_playlist_tracks` は渡した ID 列で全置換するので、必ず全曲順を渡す。
 * - **上書きしない**: 書き込みの直前に DB の全曲順を取り直し、操作を始めたときと違っていたら
 *   (別の場所で曲が足された・外されたなど) 書き込まずに取り直す。
 *
 * 手動順の一覧は検索・並べ替えなしなので、表示中の行番号がそのまま全曲順の位置になる。
 */
export function usePlaylistReorder({
  list,
  enabled,
  playlistId,
  onWritten,
  scrollToIndex,
}: PlaylistReorderOptions) {
  const listRef = useRef(list);
  listRef.current = list;
  const onWrittenRef = useRef(onWritten);
  onWrittenRef.current = onWritten;
  const scrollRef = useRef(scrollToIndex);
  scrollRef.current = scrollToIndex;

  const pendingRef = useRef<Pending | null>(null);
  // 書き込みは直列にする (前の書き込みが終わる前に次の並びを書かない)。
  const writesRef = useRef<Promise<void>>(Promise.resolve());

  /** たまっている並びを DB へ書き込む。 */
  const flush = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    clearTimeout(p.timer);
    writesRef.current = writesRef.current
      .then(async () => {
        const current = await playlistsApi.getPlaylistTrackIds(p.playlistId);
        if (!sameOrder(current, p.base)) {
          throw new Error("並べ替えの途中でプレイリストの曲が変わりました。もう一度やり直してください");
        }
        await playlistsApi.reorderPlaylistTracks(p.playlistId, p.order);
      })
      .catch((err) => {
        useStore.getState().pushToast("error", `並べ替えに失敗しました: ${err}`);
      })
      .then(() => {
        // 続きの操作がたまっていれば、その書き込みのあとでまとめて取り直す
        // (途中で取り直すと、まだ書いていない並びが画面から消える)。
        if (!pendingRef.current) onWrittenRef.current();
      });
  }, []);

  /**
   * movingIds を、全曲順の挿入位置 (0..曲数) へ 1 ブロックとして移動する。
   * 挿入位置は、いま見せている並びを受けて決める (dropAtOf。動かせなければ null)。
   */
  const move = useCallback(
    async (
      movingIds: readonly number[],
      dropAtOf: (order: readonly number[]) => number | null,
      scrollToBlock = false,
    ) => {
      if (!enabled || playlistId === null || movingIds.length === 0) return;
      let p = pendingRef.current;
      if (!p || p.playlistId !== playlistId) {
        let base: number[];
        try {
          base = await listRef.current.getIds();
        } catch (err) {
          useStore.getState().pushToast("error", `並べ替えに失敗しました: ${err}`);
          return;
        }
        // 待っているあいだに別の操作が始めていれば、それに乗る。
        p = pendingRef.current;
        if (!p || p.playlistId !== playlistId) {
          p = { playlistId, base, order: [...base], timer: undefined };
          pendingRef.current = p;
        }
      }
      const dropAt = dropAtOf(p.order);
      if (dropAt === null) return;
      const moving = [...movingIds];
      const { before, after } = anchorsForDrop(p.order, moving, dropAt);
      const next = moveIdsWithin(p.order, moving, before, after);
      if (sameOrder(next, p.order)) return;
      p.order = next;
      // 画面の並びを先に入れ替える。スクロールも、入れ替えたあとの並びでの位置へ。
      listRef.current.applyOrder(next);
      if (scrollToBlock) {
        const movingSet = new Set(moving);
        const index = next.findIndex((id) => movingSet.has(id));
        if (index >= 0) scrollRef.current(index);
      }
      clearTimeout(p.timer);
      p.timer = setTimeout(flush, WRITE_DELAY_MS);
    },
    [enabled, playlistId, flush],
  );

  /** 選択中の曲 ids を 1 つ上 / 下へ動かす (Alt+↑↓)。 */
  const moveBy = useCallback(
    (ids: ReadonlySet<number>, up: boolean) => {
      void move(
        [...ids],
        (order) => {
          const idxs: number[] = [];
          order.forEach((id, i) => {
            if (ids.has(id)) idxs.push(i);
          });
          if (idxs.length === 0) return null;
          if (up) {
            // 選択ブロックの直前にある非選択行の位置へ差し込む。
            let i = idxs[0] - 1;
            while (i >= 0 && ids.has(order[i])) i--;
            return i < 0 ? null : i; // null: すでに先頭
          }
          let i = idxs[idxs.length - 1] + 1;
          while (i < order.length && ids.has(order[i])) i++;
          return i >= order.length ? null : i + 1; // null: すでに末尾
        },
        true,
      );
    },
    [move],
  );

  // 別のプレイリストへ移る・並べ替えできない表示に変わる・画面を離れるときは、待たずに書き込む。
  useEffect(() => flush, [flush, enabled, playlistId]);

  // === 行のドラッグ ===
  // ドラッグ中の状態は ref で持ち、再描画は「挿入線の位置が変わったとき」だけに絞る。
  const dragIdsRef = useRef<number[] | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingIds, setDraggingIds] = useState<Set<number> | null>(null);

  /** ドラッグ開始: 運ぶ曲を覚える (並べ替えできない一覧でも、他所へ渡すドラッグの表示に使う)。 */
  const beginDrag = useCallback((ids: number[]) => {
    dragIdsRef.current = ids;
    setDraggingIds(new Set(ids));
  }, []);

  const endDrag = useCallback(() => {
    dragIdsRef.current = null;
    dropIndexRef.current = null;
    setDropIndex(null);
    setDraggingIds(null);
  }, []);

  const dragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      // 自前の行ドラッグのみ受ける (ファイル取り込み等は DropImportOverlay に任せる)。
      if (!enabled || !dragIdsRef.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const at = e.clientY < r.top + r.height / 2 ? index : index + 1;
      if (dropIndexRef.current !== at) {
        dropIndexRef.current = at;
        setDropIndex(at);
      }
    },
    [enabled],
  );

  const drop = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return;
      const ids = dragIdsRef.current;
      const at = dropIndexRef.current;
      endDrag();
      if (!ids || at === null) return;
      e.preventDefault();
      e.stopPropagation();
      void move(ids, () => at);
    },
    [enabled, endDrag, move],
  );

  return {
    enabled,
    moveBy,
    beginDrag,
    endDrag,
    dragOver,
    drop,
    /** 挿入線の位置 (行番号。その行の手前。曲数なら末尾)。ドラッグしていなければ null。 */
    dropIndex: enabled ? dropIndex : null,
    draggingIds,
  };
}

export type PlaylistReorder = ReturnType<typeof usePlaylistReorder>;
