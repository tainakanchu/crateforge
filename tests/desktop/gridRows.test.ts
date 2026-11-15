import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRID_GAP,
  GRID_MIN_CARD,
  GRID_PAD_X,
  buildGridRows,
  gridMetrics,
  isNearBottom,
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
