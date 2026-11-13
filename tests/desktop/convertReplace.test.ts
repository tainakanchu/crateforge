import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countLossyToLossy,
  isLosslessCodec,
  notableResults,
  reasonLabel,
} from "../../src/lib/convertReplace.ts";
import type { ReplaceItemResult } from "../../src/types/convert.ts";

test("可逆コーデックの判定", () => {
  for (const c of ["ALAC", "FLAC", "WAV", "AIFF"]) assert.equal(isLosslessCodec(c), true, c);
  for (const c of ["AAC", "MP3", "Opus"]) assert.equal(isLosslessCodec(c), false, c);
});

test("非可逆 → 非可逆の曲数 (不明は数えない、可逆の変換先では 0)", () => {
  const codecs = ["ALAC", "AAC", "MP3", null, "FLAC", undefined];
  assert.equal(countLossyToLossy(codecs, "mp3"), 2);
  assert.equal(countLossyToLossy(codecs, "aac"), 2);
  assert.equal(countLossyToLossy(codecs, "flac"), 0);
  assert.equal(countLossyToLossy(["ALAC", "FLAC"], "mp3"), 0);
});

function item(over: Partial<ReplaceItemResult>): ReplaceItemResult {
  return {
    trackId: 1,
    name: "x",
    status: "ok",
    reason: null,
    message: null,
    warnings: [],
    sourceCodec: "ALAC",
    sourceLossless: true,
    oldLocationPath: null,
    newLocationPath: null,
    original: null,
    ...over,
  };
}

test("一覧には失敗・スキップ・ゴミ箱失敗だけを出す", () => {
  const rs = [
    item({ trackId: 1 }),
    item({ trackId: 2, warnings: ["lossy_to_lossy"] }),
    item({ trackId: 3, status: "skipped", reason: "already_target_format" }),
    item({ trackId: 4, status: "failed", reason: "encode_failed" }),
    item({ trackId: 5, warnings: ["trash_failed"] }),
  ];
  assert.deepEqual(
    notableResults(rs).map((r) => r.trackId),
    [3, 4, 5],
  );
  assert.equal(reasonLabel("already_target_format"), "変換不要");
  assert.equal(reasonLabel("something_new"), "something_new");
  assert.equal(reasonLabel(null), "");
});
