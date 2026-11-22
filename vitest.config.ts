import { defineConfig } from "vitest/config";

// テストは Tauri / React を読まない純粋ロジック（src/lib など）が対象なので、
// アプリ用の vite.config.ts（React プラグイン・dev サーバー設定）は使わず node 環境で走らせる。
// mutator（pnpm test:mutation）もこのファイルを自動検出して使う。
export default defineConfig({
  test: {
    include: ["tests/desktop/**/*.test.ts"],
    environment: "node",
  },
});
