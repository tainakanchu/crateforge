import { test } from "node:test";
import assert from "node:assert/strict";
import { isListKeyEvent } from "../../src/lib/listKeys.ts";
import type { ListKeyContext } from "../../src/lib/listKeys.ts";

const base: ListKeyContext = { targetTag: "BODY", targetEditable: false, modalOpen: false };
const on = (over: Partial<ListKeyContext> = {}) => isListKeyEvent({ ...base, ...over });

test("フォーカスが無い・一覧の中・ボタンなど (文字を入力しない部品) では一覧の操作として扱う", () => {
  assert.equal(on(), true);
  assert.equal(on({ targetTag: "DIV" }), true);
  // サイドバーやツールバーのボタンにフォーカスが残っていても、↑ ↓ も PageDown も同じように効く。
  assert.equal(on({ targetTag: "BUTTON" }), true);
});

test("入力欄・セレクト・編集中の要素では扱わない (文字入力や選択肢の移動を奪わない)", () => {
  for (const targetTag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(on({ targetTag }), false, targetTag);
  }
  assert.equal(on({ targetTag: "DIV", targetEditable: true }), false);
});

test("モーダルが開いているときは扱わない", () => {
  assert.equal(on({ modalOpen: true }), false);
  assert.equal(on({ modalOpen: true, targetTag: "BUTTON" }), false);
});
