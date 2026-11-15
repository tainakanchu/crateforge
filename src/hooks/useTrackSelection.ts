import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { clampRange, moveCursor } from "../lib/windowedList";
import type { CursorKey } from "../lib/windowedList";
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import type { TrackList } from "./useTrackList";
import type { TrackActionRunner } from "./useTrackActionRunner";
import type { Track } from "../types";

/**
 * 行の参照 (範囲選択の起点・カーソル)。行番号と、その行の曲で覚える。一覧を取り直して行が
 * ずれたら曲から行を探し直す。id が null なのは、まだ読み込んでいない行へカーソルを動かした直後。
 */
export interface RowRef {
  index: number;
  id: number | null;
}

interface TrackSelectionOptions {
  list: TrackList;
  run: TrackActionRunner;
  /** 行番号の行が見えるようにスクロールする。 */
  scrollToIndex: (index: number) => void;
  /** 1 画面に入る行数 (PageUp / PageDown の移動量)。 */
  visibleRows: () => number;
}

/**
 * 曲の一覧の選択とカーソル (docs/library-list/design.md §5)。
 *
 * 選択は trackId の集合 (ストア)、範囲選択の起点とカーソルは行番号 + trackId で持つ。
 * 行番号から trackId が要るとき、読み込み済みならキャッシュから、無ければそのページか
 * 一覧の全 ID 列を取るので、読み込んでいない行をまたぐ操作も同じ結果になる。
 */
export function useTrackSelection({ list, run, scrollToIndex, visibleRows }: TrackSelectionOptions) {
  const selectedTrackIds = useStore((s) => s.selectedTrackIds);
  const setSelectedTrackIds = useStore((s) => s.setSelectedTrackIds);
  const toggleTrackSelection = useStore((s) => s.toggleTrackSelection);
  const libraryRevision = useStore((s) => s.libraryRevision);
  const memoryTracks = useStore((s) => s.tracks);

  // 非同期処理と、一度だけ張る keydown から最新の一覧を参照するための ref。
  const listRef = useRef(list);
  listRef.current = list;

  // 範囲選択の起点 (Shift の基準) と、矢印移動のカーソル位置。
  const anchorRef = useRef<RowRef | null>(null);
  const focusRef = useRef<RowRef | null>(null);

  /** 行の参照を、いまの一覧での行番号に直す。 */
  const rowIndexOf = useCallback((ref: RowRef): number => {
    const l = listRef.current;
    const fallback = Math.max(0, Math.min(ref.index, l.count - 1));
    if (ref.id === null || l.get(ref.index)?.trackId === ref.id) return fallback;
    return l.loadedIndexOf(ref.id) ?? fallback;
  }, []);

  /** 行番号 a〜b (順不同・両端を含む) の trackId。読み込んでいない行があれば全曲の ID 列から切り出す。 */
  const idsInRange = useCallback(async (a: number, b: number): Promise<number[]> => {
    const l = listRef.current;
    const range = clampRange(a, b, l.count);
    if (!range) return [];
    const out: number[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const t = l.get(i);
      if (!t) return (await l.getIds()).slice(range.start, range.end + 1);
      out.push(t.trackId);
    }
    return out;
  }, []);

  /** 行番号 a〜b を選択する (base に足す)。isCurrent が false になっていたら結果を捨てる。 */
  const selectRange = useCallback(
    async (a: number, b: number, base: ReadonlySet<number>, isCurrent: () => boolean) => {
      await run("loadTracks", async () => {
        const ids = await idsInRange(a, b);
        if (!isCurrent()) return;
        const next = new Set(base);
        for (const id of ids) next.add(id);
        setSelectedTrackIds(next);
      });
    },
    [idsInRange, run, setSelectedTrackIds],
  );

  /** 起点とカーソルを 1 行に置く (クリック・右クリック・ドラッグ開始)。 */
  const setCursor = useCallback((index: number, id: number) => {
    anchorRef.current = { index, id };
    focusRef.current = { index, id };
  }, []);

  /** 行のクリック: 通常 / Ctrl・Cmd (追加) / Shift (起点からの範囲)。 */
  const clickRow = useCallback(
    (mods: { shift: boolean; additive: boolean }, track: Track, index: number) => {
      const here: RowRef = { index, id: track.trackId };
      if (mods.shift) {
        // アンカー (前回クリック位置) から今回までを範囲選択。アンカーは動かさないので、
        // Shift クリックを繰り返すと同じ起点から伸縮できる。
        const anchor = anchorRef.current ?? here;
        anchorRef.current = anchor;
        focusRef.current = here;
        const key = listRef.current.key;
        // Shift+Ctrl/Cmd は既存選択へ追加、ただの Shift は置き換え。
        void selectRange(
          rowIndexOf(anchor),
          index,
          mods.additive ? useStore.getState().selectedTrackIds : new Set(),
          () => listRef.current.key === key,
        );
        return;
      }
      setCursor(index, track.trackId);
      toggleTrackSelection(track.trackId, mods.additive);
    },
    [selectRange, rowIndexOf, setCursor, toggleTrackSelection],
  );

  /** 一覧の全曲を選択する (読み込んでいない行も含む)。 */
  const selectAll = useCallback(() => {
    const l = listRef.current;
    const key = l.key;
    void run("loadTracks", async () => {
      const ids = await l.getIds();
      if (listRef.current.key !== key || ids.length === 0) return;
      setSelectedTrackIds(new Set(ids));
      anchorRef.current = { index: 0, id: ids[0] };
      focusRef.current = { index: ids.length - 1, id: ids[ids.length - 1] };
    });
  }, [run, setSelectedTrackIds]);

  // カーソル移動は連続して届く (キーの押しっぱなし)。古い移動の結果で選択を上書きしない。
  const cursorSeqRef = useRef(0);
  /**
   * カーソルを動かす (↑ ↓ PageUp PageDown Home End)。extend なら起点からの範囲選択。
   * 行番号だけで動かすので、読み込んでいない行へも行ける。移動先の曲の ID は、そのページだけを
   * 取って調べる (1 行動かすために全曲の ID 列は取らない)。
   */
  const moveCursorBy = useCallback(
    (key: CursorKey, extend: boolean) => {
      const l = listRef.current;
      const cursor = focusRef.current ?? anchorRef.current;
      const cur = cursor ? rowIndexOf(cursor) : null;
      const next = moveCursor(key, cur, l.count, visibleRows() - 1);
      if (next === null) return;
      scrollToIndex(next);

      const seq = ++cursorSeqRef.current;
      const listKey = l.key;
      const isCurrent = () => seq === cursorSeqRef.current && listRef.current.key === listKey;
      // 行番号は先に確定させる (ID を待つあいだに次のキーが来ても、続きから動ける)。
      const target: RowRef = { index: next, id: l.get(next)?.trackId ?? null };
      focusRef.current = target;
      if (extend) {
        // アンカーは固定。無ければ移動前のカーソル (それも無ければ移動先) を起点にする。
        anchorRef.current ??= cursor ?? target;
        void selectRange(rowIndexOf(anchorRef.current), next, new Set(), isCurrent);
        return;
      }
      // 単一選択を移動。アンカーも一緒に移す。
      anchorRef.current = target;
      void run("loadTracks", async () => {
        const id = target.id ?? (await l.ensure(next))?.trackId;
        if (!isCurrent() || id === undefined) return;
        target.id = id;
        setSelectedTrackIds(new Set([id]));
      });
    },
    [rowIndexOf, run, scrollToIndex, selectRange, setSelectedTrackIds, visibleRows],
  );

  /** フォーカス行 (無ければ選択の先頭) から、一覧の全曲をキューに入れて再生する (Enter)。 */
  const playFromCursor = useCallback(async () => {
    const l = listRef.current;
    await run("play", async () => {
      const ids = await l.getIds();
      const focus = focusRef.current;
      let index = -1;
      if (focus) {
        const i = rowIndexOf(focus);
        index = focus.id === null || ids[i] === focus.id ? i : ids.indexOf(focus.id);
      }
      if (index < 0) {
        const selected = useStore.getState().selectedTrackIds;
        index = ids.findIndex((id) => selected.has(id));
      }
      if (index < 0 || index >= ids.length) return;
      const track = await l.ensure(index);
      if (!track || !track.fileExists) return;
      await trackActions.playQueueFrom(trackApi, ids, index, ids[index]);
    });
  }, [rowIndexOf, run]);

  /**
   * 選択中の trackId を表示順で返す (同期。ドラッグ開始用)。全曲の ID 列が未取得なら、
   * 読み込み済みの行の順 → 残りは選択した順。
   */
  const orderedSelection = useCallback((): number[] => {
    const selected = useStore.getState().selectedTrackIds;
    const l = listRef.current;
    const seen = new Set<number>();
    const out: number[] = [];
    const take = (id: number) => {
      if (!selected.has(id) || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };
    const all = l.peekIds();
    if (all) all.forEach(take);
    else for (const [, t] of l.loaded()) take(t.trackId);
    selected.forEach(take);
    return out;
  }, []);

  // 選択が複数あるときは、ドラッグ開始 (同期処理) で表示順に並べられるよう ID 列を先に取っておく。
  const multiSelected = selectedTrackIds.size > 1;
  useEffect(() => {
    if (multiSelected) void list.getIds().catch(() => {});
  }, [multiSelected, list.getIds, list.key]);

  // 並び順・スコープが変わったら行番号は意味を失うので、起点とカーソルを捨てる。
  useEffect(() => {
    anchorRef.current = null;
    focusRef.current = null;
  }, [list.key]);

  // 一覧を取り直したら (ライブラリの変更)、一覧から消えた曲を選択から外す。残っている曲の選択は保つ。
  const firstRevision = useRef(true);
  useEffect(() => {
    if (firstRevision.current) {
      firstRevision.current = false;
      return;
    }
    if (useStore.getState().selectedTrackIds.size === 0) return;
    const l = listRef.current;
    const key = l.key;
    l.getIds().then(
      (ids) => {
        if (listRef.current.key !== key) return;
        const inList = new Set(ids);
        const selected = useStore.getState().selectedTrackIds;
        const kept = new Set([...selected].filter((id) => inList.has(id)));
        if (kept.size !== selected.size) setSelectedTrackIds(kept);
      },
      () => {},
    );
  }, [libraryRevision, memoryTracks, setSelectedTrackIds]);

  return {
    selectedTrackIds,
    focusRef,
    rowIndexOf,
    setCursor,
    clickRow,
    selectAll,
    moveCursorBy,
    playFromCursor,
    orderedSelection,
  };
}

export type TrackSelection = ReturnType<typeof useTrackSelection>;
