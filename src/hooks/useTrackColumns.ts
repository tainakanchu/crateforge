import { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { FIELD_DEFS } from "../types";
import type { FieldKey } from "../types";

// 曲名列の最小幅 (未固定 = flex のとき)。styles.css の .cb-id / .cb-h-id と揃える。
const NAME_MIN_WIDTH = 180;
// .cb-row / .cb-head の左右パディングと、末尾の追加ボタン列 (.cb-add-cell) の幅。
const ROW_SIDE_PADDING = 18;
const ADD_CELL_WIDTH = 40;

/**
 * 曲の一覧の列ヘッダの操作 (列幅のリサイズ・曲名列のリサイズ・ドラッグでの列の並べ替え)。
 * TrackTable から切り出した pointer 操作の状態とハンドラ。列の設定そのものはストアが持つ。
 */
export function useTrackColumns() {
  const fields = useStore((s) => s.fields);
  const fieldWidths = useStore((s) => s.fieldWidths);
  const setFieldWidth = useStore((s) => s.setFieldWidth);
  const reorderFields = useStore((s) => s.reorderFields);
  const nameColWidth = useStore((s) => s.nameColWidth);
  const setNameColWidth = useStore((s) => s.setNameColWidth);

  // === 列ヘッダの pointer 操作（リサイズ / 並べ替え） ===
  // ヘッダ各列の DOM 参照。ドラッグ中の当たり判定（挿入位置算出）に使う。
  const headRef = useRef<HTMLDivElement>(null);
  // リサイズ中の状態（ハンドル pointerdown 時にセット）。
  const resizeRef = useRef<{ key: FieldKey; startX: number; startW: number } | null>(null);
  // 列並べ替えのドラッグ状態（ヘッダ本体 pointerdown 時にセット）。
  const colDragRef = useRef<{ from: number; startX: number; pointerId: number; moved: boolean } | null>(null);
  // 並べ替え中のドロップ先インジケータ（fields 配列の挿入位置 0..fields.length）。null で非表示。
  const [dropIndicator, setDropIndicator] = useState<number | null>(null);
  // ドラッグ操作（リサイズ / 並べ替え）の直後に発火するヘッダ click をソートとして
  // 誤発火させないためのフラグ。pointerup 直後の click を 1 回だけ握りつぶす。
  const suppressNextSortClick = useRef(false);

  const clampWidth = (w: number) => Math.max(40, Math.min(600, w));

  // --- 列リサイズ（ハンドル）---
  const onResizePointerDown = (e: React.PointerEvent, id: FieldKey) => {
    // ヘッダ本体のドラッグ（並べ替え）/ ソートへ伝播させない。
    e.stopPropagation();
    e.preventDefault();
    const startW = fieldWidths[id] ?? FIELD_DEFS[id].width;
    resizeRef.current = { key: id, startX: e.clientX, startW };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    e.preventDefault();
    setFieldWidth(r.key, clampWidth(r.startW + (e.clientX - r.startX)));
  };
  const onResizePointerUp = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    e.stopPropagation();
    resizeRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    // 直後のヘッダ click（ソート）を抑止する。
    suppressNextSortClick.current = true;
  };

  // --- Track（曲名）列のリサイズ ---
  // nameColWidth が null（flex:1）のときはドラッグ開始時の実描画幅を初期値に固定幅化する。
  const nameResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  // 曲名列の最小幅。カバー/曲名が潰れないよう他列より広めにクランプ。
  const clampNameWidth = (w: number) => Math.max(160, Math.min(900, w));
  // 行の最小幅 = 左右パディング + 曲名列 (未固定なら最小 NAME_MIN_WIDTH) + 各列 + 追加ボタン列。
  // 一覧の幅がこれを下回ったら曲名列を潰さずに横スクロールさせる (列を増やしたとき / 最小ウィンドウ)。
  const rowMinWidth =
    ROW_SIDE_PADDING * 2 +
    (nameColWidth ?? NAME_MIN_WIDTH) +
    fields.reduce((sum, id) => sum + (fieldWidths[id] ?? FIELD_DEFS[id].width), 0) +
    ADD_CELL_WIDTH;
  const nameHeadRef = useRef<HTMLSpanElement>(null);
  const onNameResizePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // 現在の実描画幅を初期値に（固定済みなら nameColWidth、未固定なら DOM 実測）。
    const startW = nameColWidth ?? nameHeadRef.current?.getBoundingClientRect().width ?? 260;
    nameResizeRef.current = { startX: e.clientX, startW };
    setNameColWidth(clampNameWidth(startW));
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };
  const onNameResizePointerMove = (e: React.PointerEvent) => {
    const r = nameResizeRef.current;
    if (!r) return;
    e.preventDefault();
    setNameColWidth(clampNameWidth(r.startW + (e.clientX - r.startX)));
  };
  const onNameResizePointerUp = (e: React.PointerEvent) => {
    if (!nameResizeRef.current) return;
    e.stopPropagation();
    nameResizeRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    suppressNextSortClick.current = true;
  };

  // --- 列並べ替え（ヘッダ本体ドラッグ）---
  // pointerdown 時点の位置と列インデックスを記録し、一定距離動いたらドラッグ開始。
  // 動かなければ通常クリック（ソート）として扱う。
  const COL_DRAG_THRESHOLD = 5;
  const onHeadPointerDown = (e: React.PointerEvent, index: number) => {
    // リサイズハンドルからの down は onResizePointerDown が stopPropagation するのでここには来ない。
    if (e.button !== 0) return;
    colDragRef.current = { from: index, startX: e.clientX, pointerId: e.pointerId, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  // pointer X からドロップ先の挿入インデックス（0..fields.length）を算出する。
  const computeDropIndex = (clientX: number): number => {
    const head = headRef.current;
    if (!head) return 0;
    const cells = Array.from(
      head.querySelectorAll<HTMLElement>("[data-col-index]"),
    );
    for (const cell of cells) {
      const r = cell.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if (clientX < mid) {
        return Number(cell.dataset.colIndex);
      }
    }
    return cells.length;
  };
  const onHeadPointerMove = (e: React.PointerEvent) => {
    const d = colDragRef.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < COL_DRAG_THRESHOLD) return;
      d.moved = true;
      document.body.style.userSelect = "none";
    }
    setDropIndicator(computeDropIndex(e.clientX));
  };
  const onHeadPointerUp = (e: React.PointerEvent) => {
    const d = colDragRef.current;
    colDragRef.current = null;
    if (!d) return;
    document.body.style.userSelect = "";
    if (d.moved) {
      // 挿入位置 → reorderFields の to に変換。
      // 配列から from を抜くと、from より後ろの挿入位置は 1 つ前へずれる。
      let to = computeDropIndex(e.clientX);
      if (to > d.from) to -= 1;
      to = Math.max(0, Math.min(fields.length - 1, to));
      if (to !== d.from) reorderFields(d.from, to);
      // ドラッグ直後の click（ソート）を抑止。
      suppressNextSortClick.current = true;
    }
    setDropIndicator(null);
  };

  return {
    headRef,
    nameHeadRef,
    rowMinWidth,
    /** 並べ替え中のドロップ先 (fields の挿入位置)。null で非表示。 */
    dropIndicator,
    /** 並べ替えでドラッグ中の列 (fields の位置)。していなければ null。 */
    draggingColumn: colDragRef.current?.moved ? colDragRef.current.from : null,
    /** リサイズ / 並べ替えの直後のヘッダ click (ソート) を 1 回だけ握りつぶす。握りつぶしたら true。 */
    consumeSortClick: () => {
      if (!suppressNextSortClick.current) return false;
      suppressNextSortClick.current = false;
      return true;
    },
    onResizePointerDown,
    onResizePointerMove,
    onResizePointerUp,
    onNameResizePointerDown,
    onNameResizePointerMove,
    onNameResizePointerUp,
    onHeadPointerDown,
    onHeadPointerMove,
    onHeadPointerUp,
  };
}
