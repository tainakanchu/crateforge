import { test } from "node:test";
import assert from "node:assert/strict";
import { TRAP_CONTAINER, nextTrapFocus } from "../../src/lib/focusTrap.ts";

const els = ["first", "middle", "last"];

test("nextTrapFocus: 末尾で Tab → 先頭へ循環", () => {
  assert.equal(nextTrapFocus(els, "last", false), "first");
});

test("nextTrapFocus: 先頭で Shift+Tab → 末尾へ循環", () => {
  assert.equal(nextTrapFocus(els, "first", true), "last");
});

test("nextTrapFocus: 途中はブラウザ既定に任せる (null)", () => {
  assert.equal(nextTrapFocus(els, "middle", false), null);
  assert.equal(nextTrapFocus(els, "middle", true), null);
  assert.equal(nextTrapFocus(els, "first", false), null);
  assert.equal(nextTrapFocus(els, "last", true), null);
  // ダイアログ本体など一覧に無い要素にフォーカスがあるとき
  assert.equal(nextTrapFocus(els, null, false), null);
  assert.equal(nextTrapFocus(els, "other", true), null);
});

test("nextTrapFocus: 要素が 1 つだけならどちら向きでもその要素に留まる", () => {
  assert.equal(nextTrapFocus(["only"], "only", false), "only");
  assert.equal(nextTrapFocus(["only"], "only", true), "only");
});

test("nextTrapFocus: フォーカスできる要素が無ければダイアログ本体へ", () => {
  assert.equal(nextTrapFocus([], null, false), TRAP_CONTAINER);
  assert.equal(nextTrapFocus([], null, true), TRAP_CONTAINER);
});

