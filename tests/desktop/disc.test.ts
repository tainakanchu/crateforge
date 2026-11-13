// デスクトップ UI の純粋ロジックのテスト (Node 組み込みのテストランナー + 型ストリップ)。
// 実行: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialRipDevice } from "../../src/lib/disc.ts";

test("検出ダイアログから開いたら検出元ドライブを使う (保存済み・一覧より優先)", () => {
  assert.equal(
    initialRipDevice({ detected: "E:", saved: "D:", drives: ["D:", "E:"], fallback: "D:" }),
    "E:",
  );
});

test("検出元が無ければ保存済み → 一覧の先頭 → 既定値", () => {
  assert.equal(initialRipDevice({ detected: null, saved: "F:", drives: ["D:"], fallback: "X:" }), "F:");
  assert.equal(initialRipDevice({ detected: null, saved: null, drives: ["D:", "E:"], fallback: "X:" }), "D:");
  assert.equal(initialRipDevice({ detected: null, saved: null, drives: [], fallback: "X:" }), "X:");
  assert.equal(initialRipDevice({ detected: null, saved: null, drives: null, fallback: "X:" }), "X:");
});
