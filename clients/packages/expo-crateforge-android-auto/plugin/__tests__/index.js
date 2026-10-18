// Node 22 の `node --test <dir>` はディレクトリを glob 展開せずモジュールとして解決するため、
// ここで同ディレクトリの *.test.js を読み込む（`node --test packages/expo-crateforge-android-auto/plugin/__tests__` 用）。
const fs = require("node:fs");
const path = require("node:path");

for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith(".test.js")) require(path.join(__dirname, f));
}
