import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FIT_LEVEL, toolbarFold } from "../../src/components/toolbarFold.ts";

test("段階 0 はすべて表示 (仕様)", () => {
  assert.deepEqual(toolbarFold(0), {
    actionsIconOnly: false,
    controlsIconOnly: false,
    sortLabel: "full",
    actionsInMenu: false,
    controlsInMenu: false,
    scopeInMenu: false,
  });
});

test("段階 1: 表示切替・列をアイコンのみ、並び順は項目名だけ。取り込みはラベル付きのまま", () => {
  const f = toolbarFold(1);
  assert.equal(f.controlsIconOnly, true);
  assert.equal(f.sortLabel, "field");
  assert.equal(f.actionsIconOnly, false);
  assert.equal(f.actionsInMenu, false);
});

test("段階 2: 並び順は方向矢印だけ。取り込みはまだラベル付き", () => {
  const f = toolbarFold(2);
  assert.equal(f.sortLabel, "arrow");
  assert.equal(f.actionsIconOnly, false);
});

test("段階 3: 取り込みをアイコンのみ (まだ ⋯ には畳まない)", () => {
  const f = toolbarFold(3);
  assert.equal(f.actionsIconOnly, true);
  assert.equal(f.actionsInMenu, false);
});

test("段階 4: 取り込みを ⋯ へ。表示切替などはまだ畳まない", () => {
  const f = toolbarFold(4);
  assert.equal(f.actionsInMenu, true);
  assert.equal(f.controlsInMenu, false);
  assert.equal(f.scopeInMenu, false);
});

test("段階 5: 表示切替・並び順・列も ⋯ へ", () => {
  const f = toolbarFold(5);
  assert.equal(f.controlsInMenu, true);
  assert.equal(f.scopeInMenu, false);
});

test("段階 6 (最大): 検索範囲の切替も ⋯ へ", () => {
  assert.equal(MAX_FIT_LEVEL, 6);
  const f = toolbarFold(6);
  assert.equal(f.actionsInMenu, true);
  assert.equal(f.controlsInMenu, true);
  assert.equal(f.scopeInMenu, true);
});

test("範囲外の段階は端に丸める", () => {
  assert.deepEqual(toolbarFold(-1), toolbarFold(0));
  assert.deepEqual(toolbarFold(99), toolbarFold(MAX_FIT_LEVEL));
});

test("段階が上がっても畳んだものは戻らない (単調)", () => {
  const keys = ["actionsIconOnly", "controlsIconOnly", "actionsInMenu", "controlsInMenu", "scopeInMenu"] as const;
  for (let l = 1; l <= MAX_FIT_LEVEL; l++) {
    const prev = toolbarFold(l - 1);
    const cur = toolbarFold(l);
    for (const k of keys) {
      if (prev[k]) assert.equal(cur[k], true, `${k} at level ${l}`);
    }
  }
});
