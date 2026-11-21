import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRelativeDate,
  isRelativeDateOp,
  parseRelativeDate,
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
