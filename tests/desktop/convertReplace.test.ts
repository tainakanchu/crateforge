import { test } from "vitest";
import assert from "node:assert/strict";
import {
  countLossyToLossy,
  isLosslessCodec,
  notableResults,
  reasonLabel,
  warningLabel,
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

test("WavPack と APE も可逆として扱う (Rust 側 in_place.rs と同じ集合)", () => {
  for (const c of ["WavPack", "APE"]) assert.equal(isLosslessCodec(c), true, c);
  assert.equal(countLossyToLossy(["WavPack", "APE", "MP3"], "opus"), 1);
});

test("理由コードごとの表示名", () => {
  const labels: [string, string][] = [
    ["already_target_format", "変換不要"],
    ["not_found", "曲なし"],
    ["no_file", "ファイルなし"],
    ["probe_failed", "読み取り失敗"],
    ["encode_failed", "変換失敗"],
    ["tag_copy_failed", "タグ失敗"],
    ["decode_failed", "検証失敗"],
    ["duration_mismatch", "長さ不一致"],
    ["replace_failed", "置き換え失敗"],
  ];
  for (const [code, label] of labels) assert.equal(reasonLabel(code), label, code);
});

test("警告コードの表示名。知らないコードはそのまま出す", () => {
  assert.equal(warningLabel("lossy_to_lossy"), "非可逆→非可逆");
  assert.equal(warningLabel("trash_failed"), "ゴミ箱不可→_replaced");
  assert.equal(warningLabel("something_new"), "something_new");
});
