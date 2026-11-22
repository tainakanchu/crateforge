import { test } from "vitest";
import assert from "node:assert/strict";
import { baseName, isZipPath, looksImportable } from "../../src/lib/dropImport.ts";

test("zip はドロップの対象としてオーバーレイを出す (大文字小文字は無視)", () => {
  assert.equal(looksImportable("/Users/me/Downloads/Album.zip"), true);
  assert.equal(looksImportable("C:\\Users\\me\\Album.ZIP"), true);
  assert.equal(isZipPath("/a/Album.zip"), true);
  assert.equal(isZipPath("C:\\a\\Album.Zip"), true);
});

test("zip 以外の判定は従来どおり", () => {
  assert.equal(isZipPath("/a/song.flac"), false);
  assert.equal(isZipPath("/a/zip"), false);
  assert.equal(isZipPath("/a/.zip"), false);
  assert.equal(looksImportable("/a/song.FLAC"), true);
  assert.equal(looksImportable("/a/Album [2001.05]"), true); // フォルダ名とみなす
  assert.equal(looksImportable("/a/Folder"), true);
  assert.equal(looksImportable("/a/.hidden"), true);
  assert.equal(looksImportable("/a/cover.jpg"), false);
  assert.equal(looksImportable("/a/archive.rar"), false);
});

test("baseName はファイル名を返す", () => {
  assert.equal(baseName("/a/b/Album.zip"), "Album.zip");
  assert.equal(baseName("C:\\a\\Album.zip"), "Album.zip");
});

test("拡張子らしいものは英数 5 文字以内の全体だけ (記号を含むサフィックスはフォルダ名とみなす)", () => {
  assert.equal(looksImportable("/a/Mix vol.2-final"), true);
  assert.equal(looksImportable("/a/Live 2001.part_1"), true);
  assert.equal(looksImportable("/a/notes.backup"), true, "6 文字は拡張子とみなさない");
  assert.equal(looksImportable("/a/notes.bak"), false);
});
