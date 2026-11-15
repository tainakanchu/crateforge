import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatClock, formatYmd } from "../../src/lib/format.ts";
import { errorMessage } from "../../src/lib/errors.ts";
import { combineQuery } from "../../src/lib/query.ts";

test("formatClock: 既定は m:ss・切り捨て・時なし", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(999), "0:00");
  assert.equal(formatClock(61_000), "1:01");
  assert.equal(formatClock(59_999), "0:59");
  // 1 時間を超えても分を繰り上げない
  assert.equal(formatClock(75 * 60_000 + 3_000), "75:03");
});

test("formatClock: 値が無いときは empty、省略時は 0:00", () => {
  assert.equal(formatClock(null), "0:00");
  assert.equal(formatClock(undefined), "0:00");
  assert.equal(formatClock(-5), "0:00");
  assert.equal(formatClock(null, { empty: "" }), "");
  assert.equal(formatClock(0, { empty: "" }), "");
  assert.equal(formatClock(Number.NaN, { empty: "" }), "");
  assert.equal(formatClock(-1, { empty: "—" }), "—");
  assert.equal(formatClock(0, { empty: "--:--" }), "--:--");
  // 1 秒未満でも値があれば empty にはしない
  assert.equal(formatClock(500, { empty: "" }), "0:00");
});

test("formatClock: hours は 1 時間以上だけ h:mm:ss", () => {
  assert.equal(formatClock(59 * 60_000 + 59_000, { hours: true }), "59:59");
  assert.equal(formatClock(3_600_000, { hours: true }), "1:00:00");
  assert.equal(formatClock(75 * 60_000 + 3_000, { hours: true }), "1:15:03");
  assert.equal(formatClock(10 * 3_600_000 + 5_000, { hours: true }), "10:00:05");
});

test("formatClock: round は秒に四捨五入してから分・時へ繰り上げる", () => {
  assert.equal(formatClock(59_600), "0:59");
  assert.equal(formatClock(59_600, { round: "round" }), "1:00");
  assert.equal(formatClock(59_400, { round: "round" }), "0:59");
  assert.equal(formatClock(3_599_600, { round: "round", hours: true }), "1:00:00");
  assert.equal(formatClock(400, { round: "round", empty: "—" }), "0:00");
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(null), "0 B");
  assert.equal(formatBytes(undefined), "0 B");
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(formatBytes(1536), "1.50 KB");
  assert.equal(formatBytes(12.3 * 1024 ** 2), "12.3 MB");
  assert.equal(formatBytes(150 * 1024 ** 3), "150 GB");
  assert.equal(formatBytes(5000 * 1024 ** 4), "5000 TB");
});

test("formatYmd: ローカル日付をゼロ埋めする", () => {
  assert.equal(formatYmd(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(formatYmd(new Date(2026, 10, 15)), "2026-11-15");
});

test("errorMessage: Error / 素の {message} / それ以外", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  // Tauri コマンドのエラーは素のオブジェクトで届く ("[object Object]" にしない)
  assert.equal(errorMessage({ code: "stale", message: "plan is stale" }), "plan is stale");
  assert.equal(errorMessage("text"), "text");
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage({ message: 1 }), "[object Object]");
});

test("combineQuery: 検索語とチップを空白で結合し、空は落とす", () => {
  assert.equal(combineQuery("", []), "");
  assert.equal(combineQuery("  ", []), "");
  assert.equal(combineQuery(" daft punk ", []), "daft punk");
  assert.equal(combineQuery("", ["genre:House"]), "genre:House");
  assert.equal(combineQuery("x", ["genre:House", "", "rating:4"]), "x genre:House rating:4");
});
