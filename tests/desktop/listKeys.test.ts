import { test } from "node:test";
import assert from "node:assert/strict";
import { isListKeyEvent } from "../../src/lib/listKeys.ts";
import type { ListKeyContext } from "../../src/lib/listKeys.ts";

const base: ListKeyContext = {
  targetTag: "BODY",
  targetEditable: false,
  modalOpen: false,
  focusOnListOrNowhere: true,
  pointerOverList: false,
};
const on = (key: string, over: Partial<ListKeyContext> = {}) => isListKeyEvent(key, { ...base, ...over });

test("フォーカスがどこにも無い / 一覧の中なら、どのキーも一覧の操作として扱う", () => {
  for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Enter", "a", "Delete"]) {
    assert.equal(on(key), true, key);
  }
});

test("入力欄・セレクト・編集中の要素では扱わない (文字入力や選択肢の移動を奪わない)", () => {
  for (const targetTag of ["INPUT", "TEXTAREA", "SELECT"]) {
    for (const key of ["ArrowDown", "Home", "End", "PageDown", "a", "Enter"]) {
      assert.equal(on(key, { targetTag }), false, `${targetTag} ${key}`);
    }
  }
  assert.equal(on("ArrowDown", { targetTag: "DIV", targetEditable: true }), false);
});

test("モーダルが開いているときは扱わない", () => {
  assert.equal(on("ArrowDown", { modalOpen: true }), false);
  assert.equal(on("End", { modalOpen: true, pointerOverList: true }), false);
});

test("PageUp / PageDown / Home / End: ほかの部品にフォーカスがあるときは、ポインタが一覧の上にあるときだけ", () => {
  const elsewhere = { targetTag: "BUTTON", focusOnListOrNowhere: false };
  for (const key of ["PageUp", "PageDown", "Home", "End"]) {
    assert.equal(on(key, elsewhere), false, `${key}: サイドバーなどのスクロールを奪わない`);
    assert.equal(on(key, { ...elsewhere, pointerOverList: true }), true, key);
  }
  // ↑ ↓ などは従来どおり (ボタンにフォーカスがあっても一覧を動かす)。
  assert.equal(on("ArrowDown", elsewhere), true);
  assert.equal(on("Enter", elsewhere), true);
});
