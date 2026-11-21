import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRelativeDate,
  isRelativeDateOp,
  normalizeRelativeValue,
  parseRelativeDate,
  relativeDateError,
  relativeCountOf,
  relativeUnitOf,
  valueForOpChange,
} from "../../src/lib/relativeDate.ts";

test("相対日付の値は 正の整数 + d/w/m (バックエンドと同じ形式)", () => {
  assert.deepEqual(parseRelativeDate("30d"), { count: 30, unit: "d" });
  assert.deepEqual(parseRelativeDate(" 2W "), { count: 2, unit: "w" });
  assert.deepEqual(parseRelativeDate("3m"), { count: 3, unit: "m" });
  for (const bad of ["", "d", "0d", "-1d", "1.5d", "30", "30y", "3 m", "99999999999d"]) {
    assert.equal(parseRelativeDate(bad), null, bad);
  }
});

test("数値欄と単位から値を組み立て、取り出せる", () => {
  assert.equal(formatRelativeDate(30, "d"), "30d");
  assert.equal(formatRelativeDate("3", "m"), "3m");
  assert.equal(formatRelativeDate("", "w"), "w");
  assert.equal(relativeUnitOf("w"), "w");
  assert.equal(relativeUnitOf("12m"), "m");
  assert.equal(relativeUnitOf("2024-01-01"), "d");
  assert.equal(relativeCountOf("12m"), "12");
  assert.equal(relativeCountOf("w"), "");
});

test("演算子の切り替えで相対日付とそれ以外を行き来すると値を初期化する", () => {
  assert.ok(isRelativeDateOp("inLast"));
  assert.ok(isRelativeDateOp("notInLast"));
  assert.ok(!isRelativeDateOp("is"));
  assert.equal(valueForOpChange("contains", "inLast", "2024-01-01"), "30d");
  assert.equal(valueForOpChange("inLast", "is", "30d"), "");
  assert.equal(valueForOpChange("inLast", "notInLast", "3m"), "3m");
  assert.equal(valueForOpChange("is", "contains", "2024"), "2024");
});

test("期間の上限は 36500 日 / 5200 週 / 1200 か月 (バックエンドと同じ)", () => {
  assert.deepEqual(parseRelativeDate("36500d"), { count: 36500, unit: "d" });
  assert.deepEqual(parseRelativeDate("5200w"), { count: 5200, unit: "w" });
  assert.deepEqual(parseRelativeDate("1200m"), { count: 1200, unit: "m" });
  for (const bad of ["36501d", "5201w", "1201m"]) {
    assert.equal(parseRelativeDate(bad), null, bad);
    assert.ok(relativeDateError(bad), bad);
  }
  assert.equal(relativeDateError("30d"), null);
  assert.ok(relativeDateError("d"));
});

test("読み込んだ単位なしの整数は日数として正規化する", () => {
  assert.equal(normalizeRelativeValue("30"), "30d");
  assert.equal(normalizeRelativeValue(" 7 "), "7d");
  assert.equal(normalizeRelativeValue("3m"), "3m");
  assert.equal(normalizeRelativeValue(""), "");
  assert.equal(normalizeRelativeValue("x"), "x");
});
