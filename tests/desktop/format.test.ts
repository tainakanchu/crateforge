import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBytes,
  formatPlaybackTime,
  formatRemainingTime,
  formatTotalTime,
  formatTrackTime,
  formatYmd,
} from "../../src/lib/format.ts";
import { errorMessage } from "../../src/lib/errors.ts";
import { combineQuery } from "../../src/lib/query.ts";

// ---- 時間表示 (docs/ui-spec.md §3.8) ----
const HOUR = 75 * 60_000 + 3_000; // 1 時間 15 分 3 秒
const ALMOST_MIN = 59_999; // 切り捨てなので 0:59
const ALMOST_HOUR = 3_599_999; // 切り捨てなので 59:59

function table(fn: (ms: number | null | undefined) => string, rows: [number | null | undefined, string][]) {
  for (const [input, want] of rows) {
    assert.equal(fn(input), want, `${fn.name}(${input})`);
  }
}

test("formatTrackTime: m:ss・切り捨て・時を付けない・長さ不明は空", () => {
  table(formatTrackTime, [
    [61_000, "1:01"],
    [ALMOST_MIN, "0:59"],
    [500, "0:00"],
    [HOUR, "75:03"],
    [ALMOST_HOUR, "59:59"],
    [null, ""],
    [undefined, ""],
    [0, ""],
    [Number.NaN, ""],
    [-1000, ""],
  ]);
});

test("formatTotalTime: 1 時間以上は h:mm:ss・切り捨て・値なしは 0:00", () => {
  table(formatTotalTime, [
    [61_000, "1:01"],
    [ALMOST_MIN, "0:59"],
    [ALMOST_HOUR, "59:59"],
    [3_600_000, "1:00:00"],
    [HOUR, "1:15:03"],
    [10 * 3_600_000 + 5_000, "10:00:05"],
    [null, "0:00"],
    [undefined, "0:00"],
    [0, "0:00"],
    [Number.NaN, "0:00"],
    [-1000, "0:00"],
  ]);
});

test("formatPlaybackTime: m:ss・切り捨て・時を付けない・値なしは 0:00", () => {
  table(formatPlaybackTime, [
    [61_000, "1:01"],
    [ALMOST_MIN, "0:59"],
    [HOUR, "75:03"],
    [0, "0:00"],
    [null, "0:00"],
    [Number.NaN, "0:00"],
    [-1000, "0:00"],
  ]);
});

test("formatRemainingTime: -m:ss・切り捨て・曲長を超えたら -0:00", () => {
  assert.equal(formatRemainingTime(0, 185_000), "-3:05");
  assert.equal(formatRemainingTime(400, 60_000), "-0:59");
  assert.equal(formatRemainingTime(60_000, 60_000), "-0:00");
  assert.equal(formatRemainingTime(70_000, 60_000), "-0:00");
  assert.equal(formatRemainingTime(0, 0), "-0:00");
  assert.equal(formatRemainingTime(0, HOUR), "-75:03");
  assert.equal(formatRemainingTime(0, Number.NaN), "-0:00");
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
