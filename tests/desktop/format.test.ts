import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAlbumTotal,
  formatArtistViewTime,
  formatBytes,
  formatClock,
  formatDiscTotal,
  formatDiscTrackLength,
  formatDuplicateLength,
  formatInfoDuration,
  formatListTotal,
  formatPlaybackTime,
  formatRemainingTime,
  formatSetDuration,
  formatTrackTime,
  formatTriageDuration,
  formatYmd,
} from "../../src/lib/format.ts";
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

// ---- 用途別の時間表示: 現行の出力を固定する (フェーズ 2 A2 で意図的に変える) ----
// 列: [入力 ms, 期待値]。共通の入力で丸め (59.6 秒)・1 時間超・値なし・NaN・負値を見る。
const HOUR = 75 * 60_000 + 3_000; // 1:15:03
const ROUND_UP = 59_600; // 切り捨て 0:59 / 四捨五入 1:00
const HOUR_EDGE = 3_599_600; // 切り捨て 59:59 / 四捨五入で 1 時間

function table(fn: (ms: number | null | undefined) => string, rows: [number | null | undefined, string][]) {
  for (const [input, want] of rows) {
    assert.equal(fn(input), want, `${fn.name}(${input})`);
  }
}

test("formatTrackTime: m:ss・切り捨て・時なし・値なしは空", () => {
  table(formatTrackTime, [
    [61_000, "1:01"],
    [ROUND_UP, "0:59"],
    [HOUR, "75:03"],
    [null, ""],
    [undefined, ""],
    [0, ""],
    [Number.NaN, ""],
    [-1000, ""],
  ]);
});

test("formatAlbumTotal: m:ss・切り捨て・時を付けない・値なしは空", () => {
  table(formatAlbumTotal, [
    [61_000, "1:01"],
    [ROUND_UP, "0:59"],
    [HOUR, "75:03"],
    [HOUR_EDGE, "59:59"],
    [null, ""],
    [0, ""],
    [Number.NaN, ""],
    [-1000, ""],
  ]);
});

test("formatArtistViewTime: 1 時間以上は h:mm:ss・切り捨て・値なしは空", () => {
  table(formatArtistViewTime, [
    [61_000, "1:01"],
    [ROUND_UP, "0:59"],
    [HOUR, "1:15:03"],
    [HOUR_EDGE, "59:59"],
    [3_600_000, "1:00:00"],
    [null, ""],
    [0, ""],
    [Number.NaN, ""],
    [-1000, ""],
  ]);
});

test("formatPlaybackTime: m:ss・切り捨て・時なし・値なしは 0:00", () => {
  table(formatPlaybackTime, [
    [61_000, "1:01"],
    [ROUND_UP, "0:59"],
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

test("formatListTotal: m:ss・切り捨て・時を付けない・空なら 0:00", () => {
  table(formatListTotal, [
    [61_000, "1:01"],
    [ROUND_UP, "0:59"],
    [HOUR, "75:03"],
    [0, "0:00"],
    [Number.NaN, "0:00"],
    [-1000, "0:00"],
  ]);
});

test("formatTriageDuration: m:ss・切り捨て・時なし・値なしは —", () => {
  table(formatTriageDuration, [
    [61_000, "1:01"],
    [ROUND_UP, "0:59"],
    [HOUR, "75:03"],
    [null, "—"],
    [undefined, "—"],
    [0, "—"],
    [Number.NaN, "—"],
    [-1000, "—"],
  ]);
});

test("formatDuplicateLength: m:ss・四捨五入・時なし・値なしは --:--", () => {
  table(formatDuplicateLength, [
    [61_000, "1:01"],
    [ROUND_UP, "1:00"],
    [59_400, "0:59"],
    [HOUR, "75:03"],
    [HOUR_EDGE, "60:00"],
    [400, "0:00"],
    [null, "--:--"],
    [0, "--:--"],
    [Number.NaN, "--:--"],
    [-1000, "--:--"],
  ]);
});

test("formatInfoDuration: 1 時間以上は h:mm:ss・四捨五入・値なしは —", () => {
  table(formatInfoDuration, [
    [61_000, "1:01"],
    [ROUND_UP, "1:00"],
    [HOUR, "1:15:03"],
    [HOUR_EDGE, "1:00:00"],
    [400, "0:00"],
    [null, "—"],
    [undefined, "—"],
    [0, "—"],
    [Number.NaN, "—"],
    [-1000, "—"],
  ]);
});

test("formatSetDuration: 1 時間以上は h:mm:ss・切り捨て・値なしは 0:00", () => {
  table(formatSetDuration, [
    [61_000, "1:01"],
    [ROUND_UP, "0:59"],
    [HOUR, "1:15:03"],
    [HOUR_EDGE, "59:59"],
    [0, "0:00"],
    [Number.NaN, "0:00"],
    [-1000, "0:00"],
  ]);
});

test("formatDiscTotal: 秒で受ける・1 時間以上は h:mm:ss・四捨五入", () => {
  assert.equal(formatDiscTotal(61), "1:01");
  assert.equal(formatDiscTotal(59.6), "1:00");
  assert.equal(formatDiscTotal(59.4), "0:59");
  assert.equal(formatDiscTotal(4503), "1:15:03");
  assert.equal(formatDiscTotal(3599.6), "1:00:00");
  assert.equal(formatDiscTotal(0), "0:00");
  assert.equal(formatDiscTotal(Number.NaN), "0:00");
  assert.equal(formatDiscTotal(-5), "0:00");
});

test("formatDiscTrackLength: 整数秒で受ける・m:ss・時なし", () => {
  assert.equal(formatDiscTrackLength(202), "3:22");
  assert.equal(formatDiscTrackLength(59), "0:59");
  assert.equal(formatDiscTrackLength(4503), "75:03");
  assert.equal(formatDiscTrackLength(0), "0:00");
  assert.equal(formatDiscTrackLength(Number.NaN), "0:00");
  assert.equal(formatDiscTrackLength(-5), "0:00");
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
