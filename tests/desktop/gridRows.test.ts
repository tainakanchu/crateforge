import { test } from "node:test";
import assert from "node:assert/strict";
import { Virtualizer } from "@tanstack/react-virtual";
import {
  GRID_GAP,
  GRID_MIN_CARD,
  GRID_PAD_X,
  appendUniqueBy,
  buildGridRows,
  gridMetrics,
  isNearBottom,
  remeasureGridRows,
  shouldRemeasureGrid,
} from "../../src/lib/gridRows.ts";

const keyOf = (s: string) => s;
const items = ["a", "b", "c", "d", "e", "f", "g"];

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

test("buildGridRows: cols 枚ずつに分ける", () => {
  const rows = buildGridRows(items, 3, keyOf, null);
  assert.deepEqual(
    rows.map((r) => (r.type === "grid" ? r.items : null)),
    [["a", "b", "c"], ["d", "e", "f"], ["g"]],
  );
});

test("buildGridRows: 展開行は展開した項目を含む行の直後に入る", () => {
  const rows = buildGridRows(items, 3, keyOf, "e");
  assert.deepEqual(
    rows.map((r) => r.type),
    ["grid", "grid", "expand", "grid"],
  );
  const x = rows[2];
  assert.equal(x.type === "expand" ? x.item : null, "e");
});

test("buildGridRows: 展開の開閉でグリッド行のキーが変わらない", () => {
  const gridKeys = (expanded: string | null) =>
    buildGridRows(items, 3, keyOf, expanded)
      .filter((r) => r.type === "grid")
      .map((r) => r.key);
  const closed = gridKeys(null);
  assert.deepEqual(gridKeys("a"), closed);
  assert.deepEqual(gridKeys("e"), closed);
  assert.deepEqual(gridKeys("g"), closed);
});

test("buildGridRows: 展開行のキーは項目キーから決まる (位置・列数によらない)", () => {
  const key = (expanded: string, cols = 3) =>
    buildGridRows(items, cols, keyOf, expanded).find((r) => r.type === "expand")?.key;
  assert.equal(key("a"), "x:a");
  assert.equal(key("g"), "x:g");
  assert.equal(key("g", 2), "x:g");
});

test("buildGridRows: 行キーは一意 (同じ項目が複数回あっても)", () => {
  const dup = ["a", "b", "a", "b", "a", "b"];
  const keys = buildGridRows(dup, 2, keyOf, null).map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("buildGridRows: 列数が変わるとグリッド行のキーも変わる (高さが変わるため)", () => {
  const k2 = buildGridRows(items, 2, keyOf, null)[0].key;
  const k3 = buildGridRows(items, 3, keyOf, null)[0].key;
  assert.notEqual(k2, k3);
});

test("buildGridRows: 空なら行なし、該当しない expandedKey は無視", () => {
  assert.deepEqual(buildGridRows([], 3, keyOf, "a"), []);
  assert.equal(buildGridRows(items, 3, keyOf, "zzz").length, 3);
});

test("isNearBottom: 末尾の手前 400px 以内で true", () => {
  assert.equal(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 2000 }), false);
  assert.equal(isNearBottom({ scrollTop: 1099, clientHeight: 500, scrollHeight: 2000 }), false);
  assert.equal(isNearBottom({ scrollTop: 1100, clientHeight: 500, scrollHeight: 2000 }), true);
});

test("buildGridRows: keyOf を省略するとグリッド行だけを返す (展開なしのグリッド)", () => {
  const rows = buildGridRows(items, 3);
  assert.deepEqual(
    rows.map((r) => [r.type, r.key, r.items.length]),
    [
      ["grid", "g:3:0", 3],
      ["grid", "g:3:1", 3],
      ["grid", "g:3:2", 1],
    ],
  );
});

test("shouldRemeasureGrid: 初回は測る", () => {
  assert.equal(shouldRemeasureGrid(null, { gridRowHeight: 214, cols: 5 }), true);
});

test("shouldRemeasureGrid: カード幅 (行の高さ) か列数が変わったら測り直す", () => {
  const prev = { gridRowHeight: 214, cols: 5 };
  assert.equal(shouldRemeasureGrid(prev, { gridRowHeight: 229, cols: 5 }), true);
  assert.equal(shouldRemeasureGrid(prev, { gridRowHeight: 214, cols: 4 }), true);
});

test("shouldRemeasureGrid: 寸法が同じなら測り直さない (展開の開閉・追加ロードで呼ばれても)", () => {
  // 展開行の重なりの回帰テスト: 判定の入力は寸法だけで、行リストや展開状態を含まない。
  // 開閉や追加ロードのあとの再レンダーでは寸法が変わらないので、実測キャッシュは捨てられない。
  const key = { gridRowHeight: 214, cols: 5 };
  const closed = buildGridRows(items, 3, keyOf, null);
  const opened = buildGridRows(items, 3, keyOf, "e");
  assert.notEqual(closed.length, opened.length);
  assert.equal(shouldRemeasureGrid(key, { ...key }), false);
  assert.equal(shouldRemeasureGrid.length, 2);
});

test("appendUniqueBy: 既出のキーは足さず、順序を保つ", () => {
  assert.deepEqual(appendUniqueBy(["a", "b"], ["b", "c", "a", "d"], keyOf), ["a", "b", "c", "d"]);
  assert.deepEqual(appendUniqueBy([], ["a", "a", "b"], keyOf), ["a", "b"]);
  assert.deepEqual(appendUniqueBy(["a"], [], keyOf), ["a"]);
});

test("appendUniqueBy: 追加後も展開行のキーが一意", () => {
  const all = appendUniqueBy(["a", "b", "c"], ["c", "d"], keyOf);
  for (const k of all) {
    const expandRows = buildGridRows(all, 2, keyOf, k).filter((r) => r.type === "expand");
    assert.equal(expandRows.length, 1);
  }
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
