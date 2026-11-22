// デスクトップ UI の純粋ロジックのテスト (Vitest)。
// 実行: pnpm test
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { defaultDevice, initialRipDevice } from "../../src/lib/disc.ts";

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

test("既定のドライブは OS ごとの CD ドライブ名", () => {
  try {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    assert.equal(defaultDevice(), "D:");
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" });
    assert.equal(defaultDevice(), "disk1");
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    assert.equal(defaultDevice(), "/dev/cdrom");
  } finally {
    vi.unstubAllGlobals();
  }
});
