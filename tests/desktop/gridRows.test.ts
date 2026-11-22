import { test } from "vitest";
import assert from "node:assert/strict";
import { Virtualizer } from "@tanstack/react-virtual";
import {
  GRID_GAP,
  GRID_MIN_CARD,
  GRID_PAD_X,
  gridLayout,
  gridMetrics,
  relocateExpanded,
  remeasureGridRows,
  shouldRemeasureGrid,
} from "../../src/lib/gridRows.ts";

test("gridMetrics: 幅 0 (未計測) は 2 列・最小カード幅", () => {
  assert.deepEqual(gridMetrics(0), { cols: 2, cardW: GRID_MIN_CARD });
});

test("gridMetrics: 狭くても 2 列を下回らず、カード幅は 60 を下回らない", () => {
  const m = gridMetrics(100);
  assert.equal(m.cols, 2);
  assert.equal(m.cardW, 60);
});

test("gridMetrics: 列数は最小カード幅で入る数、カード幅は余りを均等に配る", () => {
  // 内側 = 1000 - 40 = 960 → (960 + 18) / 168 = 5.82 → 5 列
  const m = gridMetrics(1000);
  assert.equal(m.cols, 5);
  assert.equal(m.cardW, (1000 - GRID_PAD_X * 2 - GRID_GAP * 4) / 5);
  // ちょうど 4 列入る幅と、その 1px 手前
  const exact = GRID_PAD_X * 2 + GRID_MIN_CARD * 4 + GRID_GAP * 3;
  assert.deepEqual(gridMetrics(exact), { cols: 4, cardW: GRID_MIN_CARD });
  assert.equal(gridMetrics(exact - 1).cols, 3);
});

const rowsOf = (layout: ReturnType<typeof gridLayout>) =>
  Array.from({ length: layout.rowCount }, (_, i) => layout.rowAt(i));

test("gridLayout: 件数だけで行が決まる (cols 枚ずつ。最後の行は端数)", () => {
  const layout = gridLayout(7, 3);
  assert.equal(layout.rowCount, 3);
  assert.deepEqual(rowsOf(layout), [
    { type: "grid", key: "g:3:0", start: 0, end: 3 },
    { type: "grid", key: "g:3:1", start: 3, end: 6 },
    { type: "grid", key: "g:3:2", start: 6, end: 7 },
  ]);
});

test("gridLayout: 行数は最初から全件ぶん (3,152 件 × 5 列 = 631 行)", () => {
  const layout = gridLayout(3152, 5);
  assert.equal(layout.rowCount, 631);
  assert.deepEqual(layout.rowAt(630), { type: "grid", key: "g:5:630", start: 3150, end: 3152 });
});

test("gridLayout: 展開行は展開した項目を含む行の直後に 1 つだけ入る", () => {
  const layout = gridLayout(7, 3, { key: "e", index: 4 });
  assert.deepEqual(
    rowsOf(layout).map((r) => r.type),
    ["grid", "grid", "expand", "grid"],
  );
  assert.deepEqual(layout.rowAt(2), { type: "expand", key: "x:e", itemIndex: 4 });
  // 展開行の後ろのカード行は、展開していないときと同じ項目を指す。
  assert.deepEqual(layout.rowAt(3), { type: "grid", key: "g:3:2", start: 6, end: 7 });
});

test("gridLayout: 展開の開閉でカード行のキーも中身も変わらない (行が重ならない)", () => {
  const grid = (expanded: { key: string; index: number } | null) =>
    rowsOf(gridLayout(7, 3, expanded)).filter((r) => r.type === "grid");
  const closed = grid(null);
  assert.deepEqual(grid({ key: "a", index: 0 }), closed);
  assert.deepEqual(grid({ key: "e", index: 4 }), closed);
  assert.deepEqual(grid({ key: "g", index: 6 }), closed);
});

test("gridLayout: 展開行のキーは項目キーから決まる (位置・列数によらない)", () => {
  const key = (index: number, cols: number) =>
    rowsOf(gridLayout(7, cols, { key: "k", index })).find((r) => r.type === "expand")?.key;
  assert.equal(key(0, 3), "x:k");
  assert.equal(key(6, 3), "x:k");
  assert.equal(key(6, 2), "x:k");
});

test("gridLayout: 行キーは一意", () => {
  const keys = rowsOf(gridLayout(50, 4, { key: "k", index: 17 })).map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("gridLayout: 列数が変わるとカード行のキーも変わる (高さが変わるため)", () => {
  assert.notEqual(gridLayout(7, 2).rowAt(0).key, gridLayout(7, 3).rowAt(0).key);
});

test("gridLayout: 空なら行なし。件数の外を指す展開は無視する", () => {
  assert.equal(gridLayout(0, 3, { key: "a", index: 0 }).rowCount, 0);
  assert.equal(gridLayout(7, 3, { key: "zzz", index: 7 }).rowCount, 3);
  assert.equal(gridLayout(7, 3, { key: "zzz", index: -1 }).rowCount, 3);
});

test("gridLayout.itemRange: 見えている行の項目の範囲 (両端を含む)", () => {
  const layout = gridLayout(100, 5);
  assert.deepEqual(layout.itemRange(0, 2), { start: 0, end: 14 });
  assert.deepEqual(layout.itemRange(19, 19), { start: 95, end: 99 });
  // 最後の行が端数でも件数を超えない。行番号は範囲に丸める。
  assert.deepEqual(gridLayout(7, 3).itemRange(1, 99), { start: 3, end: 6 });
  assert.deepEqual(gridLayout(7, 3).itemRange(50, 99), { start: 6, end: 6 }, "両端とも外なら最後の行");
  assert.equal(gridLayout(0, 3).itemRange(0, 0), null);
  assert.equal(layout.itemRange(3, 2), null);
});

test("gridLayout.itemRange: 展開行をまたいでも項目の範囲がずれない", () => {
  // 行: 0=g0, 1=g1, 2=展開 (項目 4), 3=g2, 4=g3
  const layout = gridLayout(12, 3, { key: "e", index: 4 });
  assert.deepEqual(layout.itemRange(0, 1), { start: 0, end: 5 });
  assert.deepEqual(layout.itemRange(2, 2), { start: 3, end: 5 }, "展開行だけ → 展開した項目の行");
  assert.deepEqual(layout.itemRange(2, 3), { start: 3, end: 8 });
  assert.deepEqual(layout.itemRange(3, 4), { start: 6, end: 11 });
});

test("relocateExpanded: 同じ位置に同じ項目があればそのまま", () => {
  const ex = { key: "b", index: 1 };
  assert.equal(relocateExpanded(ex, 3, (i) => ["a", "b", "c"][i], []), ex);
  assert.equal(relocateExpanded(null, 3, () => "a", []), null);
});

test("relocateExpanded: 位置がずれたら取得済みの項目から探して移す", () => {
  const keys = ["x", "a", "b", "c"];
  const loaded = keys.map((k, i): [number, string] => [i, k]);
  assert.deepEqual(relocateExpanded({ key: "b", index: 1 }, 4, (i) => keys[i], loaded), {
    key: "b",
    index: 2,
  });
});

test("relocateExpanded: 見つからなければ閉じる。未取得の位置は判定を保留する", () => {
  const keys = ["a", "c"];
  const loaded = keys.map((k, i): [number, string] => [i, k]);
  assert.equal(relocateExpanded({ key: "b", index: 1 }, 2, (i) => keys[i], loaded), null);
  const ex = { key: "b", index: 500 };
  assert.equal(relocateExpanded(ex, 1000, () => undefined, loaded), ex);
  // 件数が減って位置そのものが無くなったら、探し直す (無ければ閉じる)。
  assert.equal(relocateExpanded(ex, 2, () => undefined, loaded), null);
  // 位置が件数とちょうど同じ (末尾の 1 つ先) も「位置が無くなった」側。
  assert.deepEqual(relocateExpanded({ key: "c", index: 2 }, 2, () => undefined, loaded), {
    key: "c",
    index: 1,
  });
  assert.deepEqual(relocateExpanded({ key: "c", index: 500 }, 2, () => undefined, loaded), {
    key: "c",
    index: 1,
  });
});

test("shouldRemeasureGrid: 初回は測る", () => {
  assert.equal(shouldRemeasureGrid(null, { gridRowHeight: 214, cols: 5 }), true);
});

test("shouldRemeasureGrid: カード幅 (行の高さ) か列数が変わったら測り直す", () => {
  const prev = { gridRowHeight: 214, cols: 5 };
  assert.equal(shouldRemeasureGrid(prev, { gridRowHeight: 229, cols: 5 }), true);
  assert.equal(shouldRemeasureGrid(prev, { gridRowHeight: 214, cols: 4 }), true);
});

test("shouldRemeasureGrid: 寸法が同じなら測り直さない (展開の開閉・ページの到着で呼ばれても)", () => {
  // 展開行の重なりの回帰テスト: 判定の入力は寸法だけで、行の並びや展開状態を含まない。
  // 開閉やページの到着のあとの再レンダーでは寸法が変わらないので、実測キャッシュは捨てられない。
  const key = { gridRowHeight: 214, cols: 5 };
  const closed = gridLayout(7, 3, null);
  const opened = gridLayout(7, 3, { key: "e", index: 4 });
  assert.notEqual(closed.rowCount, opened.rowCount);
  assert.equal(shouldRemeasureGrid(key, { ...key }), false);
  assert.equal(shouldRemeasureGrid.length, 2);
});

// ---- remeasureGridRows (列数/カード幅が変わったときの測り直し) ----

/** DOM なしで動かす virtual-core の Virtualizer。行キーは keys、見積もりは estimate。 */
function makeVirtualizer(keys: string[], estimate: (i: number) => number) {
  return new Virtualizer<HTMLElement, Element>({
    count: keys.length,
    getScrollElement: () => null,
    estimateSize: estimate,
    getItemKey: (i) => keys[i],
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  });
}

/** 各行の [キー, 開始位置, 高さ]。getTotalSize() で位置の配列を最新にしてから読む。 */
function layoutOf(v: Virtualizer<HTMLElement, Element>) {
  v.getTotalSize();
  return Array.from({ length: v.options.count }, (_, i) => {
    const it = v.measurementsCache[i]!;
    return [it.key, it.start, it.size];
  });
}

test("remeasureGridRows: 高さが変わらなかった展開行も実測値のまま残る (見積もりに戻らない)", () => {
  // グリッド行 / 展開行 (曲 16 行で 664px、見積もり 260) / グリッド行
  const keys = ["g:6:0", "x:zanaka", "g:6:1"];
  const v = makeVirtualizer(keys, (i) => (i === 1 ? 260 : 256));
  v.getTotalSize();
  v.resizeItem(0, 256);
  v.resizeItem(1, 664);
  v.resizeItem(2, 256);
  assert.equal(v.getTotalSize(), 256 + 664 + 256);

  // 列数 6 → 5 でカード幅が変わりグリッド行は高くなるが、展開行の高さは 664 のまま。
  remeasureGridRows(v, [
    { index: 0, size: 300 },
    { index: 1, size: 664 },
    { index: 2, size: 300 },
  ]);
  assert.deepEqual(
    layoutOf(v),
    [
      ["g:6:0", 0, 300],
      ["x:zanaka", 300, 664],
      ["g:6:1", 964, 300],
    ],
  );
  assert.equal(v.getTotalSize(), 300 + 664 + 300);
});

test("remeasureGridRows: スクロール中 (isScrolling) でも測り直す", () => {
  // measureElement はスクロール中は同期計測を飛ばす。測り直しはそれに頼らない。
  const keys = ["g:6:0", "x:zanaka", "g:6:1"];
  const v = makeVirtualizer(keys, (i) => (i === 1 ? 260 : 256));
  v.getTotalSize();
  v.resizeItem(1, 664);
  v.isScrolling = true;
  remeasureGridRows(v, [{ index: 1, size: 664 }]);
  assert.equal(layoutOf(v)[1]![2], 664);
  assert.equal(v.getTotalSize(), 256 + 664 + 256);
});

test("remeasureGridRows: 描画されていない行は見積もりに戻る", () => {
  const keys = ["g:6:0", "x:zanaka", "g:6:1", "g:6:2"];
  const v = makeVirtualizer(keys, (i) => (i === 1 ? 260 : 256));
  v.getTotalSize();
  v.resizeItem(3, 400);
  remeasureGridRows(v, [{ index: 0, size: 256 }]);
  assert.equal(layoutOf(v)[3]![2], 256);
});
