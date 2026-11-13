import { test } from "node:test";
import assert from "node:assert/strict";
import { joinGenre, splitGenre } from "../../src/lib/genre.ts";

test("ジャンルは空白区切りのタグ (仕様)", () => {
  assert.deepEqual(splitGenre("Anime Remix Eurobeat"), ["Anime", "Remix", "Eurobeat"]);
  assert.deepEqual(splitGenre("DeepHouse"), ["DeepHouse"]);
  assert.deepEqual(splitGenre("  House \t Techno  "), ["House", "Techno"]);
});

test("v0.18–v0.19 が保存した ; , 区切りも分割し、/ は区切らない", () => {
  assert.deepEqual(splitGenre("House; Techno"), ["House", "Techno"]);
  assert.deepEqual(splitGenre("House,Techno"), ["House", "Techno"]);
  assert.deepEqual(splitGenre("R&B/Soul"), ["R&B/Soul"]);
});

test("空・null は空配列", () => {
  assert.deepEqual(splitGenre(""), []);
  assert.deepEqual(splitGenre(null), []);
  assert.deepEqual(splitGenre(" ; , "), []);
});

test("連結は半角空白 1 つで、空白を含むタグは分けて保存する", () => {
  assert.equal(joinGenre(["House", "Techno"]), "House Techno");
  assert.equal(joinGenre(["Deep House", "", " Techno "]), "Deep House Techno");
  assert.equal(joinGenre(splitGenre("House; Techno")), "House Techno");
});
