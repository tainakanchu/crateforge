import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { isCursorKey } from "../lib/windowedList";
import { isListKeyEvent } from "../lib/listKeys";
import type { TrackSelection } from "./useTrackSelection";
import type { PlaylistReorder } from "./usePlaylistReorder";

interface TrackListKeysOptions {
  /** 一覧の件数 (0 のあいだは何もしない)。 */
  count: number;
  selection: TrackSelection;
  reorder: PlaylistReorder;
  /** Delete (macOS は Cmd+Backspace も): 選択中の曲の削除確認を開く。 */
  onDelete: (trackIds: number[]) => void;
  /** アプリケーションキー / Shift+F10: コンテキストメニューを開く。 */
  onMenuKey: () => void;
}

/**
 * 曲の一覧のキーボード操作。window の keydown を 1 つだけ張り、最新の値は ref から読む。
 *
 * - ↑ ↓ / PageUp PageDown / Home End: カーソル移動 (Shift で範囲選択)
 * - Alt+↑ ↓: プレイリストの手動順で、選択行を 1 つ上 / 下へ
 * - Ctrl・Cmd+A: 全選択 / Enter: カーソルの行から再生
 * - Delete: 削除確認 / アプリケーションキー・Shift+F10: コンテキストメニュー
 *
 * どのイベントを受けるかは lib/listKeys.ts の `isListKeyEvent` (入力欄・セレクト・編集中の要素・
 * モーダルを除く。どのキーも同じ条件)。
 */
export function useTrackListKeys(options: TrackListKeysOptions) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { count, selection, reorder, onDelete, onMenuKey } = latest.current;
      const target = e.target as HTMLElement | null;
      const handled = isListKeyEvent({
        targetTag: target?.tagName ?? null,
        targetEditable: target?.isContentEditable === true,
        modalOpen: document.querySelector(".modal-overlay") !== null,
      });
      if (!handled) return;

      const cmd = e.ctrlKey || e.metaKey;
      const selected = useStore.getState().selectedTrackIds;

      if (e.key === "Delete" || (e.metaKey && e.key === "Backspace")) {
        if (selected.size === 0) return;
        e.preventDefault();
        onDelete(Array.from(selected));
        return;
      }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        if (selected.size === 0) return;
        e.preventDefault();
        onMenuKey();
        return;
      }
      if (count === 0) return;

      // Ctrl/Cmd+A: 全選択 (読み込んでいない行も含む一覧の全曲)。
      if (cmd && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selection.selectAll();
        return;
      }
      // Enter: フォーカス行 (無ければ選択先頭) の曲を再生。
      if (e.key === "Enter" && !cmd) {
        if (!selection.focusRef.current && selected.size === 0) return;
        e.preventDefault();
        void selection.playFromCursor();
        return;
      }

      if (!isCursorKey(e.key)) return;
      if (cmd) return; // Cmd/Ctrl+矢印は別操作 (音量) に譲る。
      const isArrow = e.key === "ArrowDown" || e.key === "ArrowUp";
      if (e.altKey && !isArrow) return;
      // Alt+↑/↓: プレイリストの手動順のとき、選択行を 1 つ上/下へ動かす
      // (ドラッグ並べ替えのキーボード版)。手動順でなければ通常の選択移動に落とす。
      if (e.altKey && reorder.enabled) {
        if (selected.size === 0) return;
        e.preventDefault();
        reorder.moveBy(selected, e.key === "ArrowUp");
        return;
      }
      e.preventDefault();
      selection.moveCursorBy(e.key, e.shiftKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
