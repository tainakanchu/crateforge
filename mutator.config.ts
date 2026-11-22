import { defineConfig } from "@mizchi/mutator";

// ミューテーションテスト（pnpm test:mutation / test:mutation:diff）の設定。
// 対象は tests/desktop のテストがある純粋ロジックだけにする。React コンポーネント・Tauri API の
// 配線・テストの無いモジュールを入れると NoCoverage ばかりになりスコアの意味が薄れるため、
// テストを足したモジュールはここにも足す。運用は docs/testing/mutation.md を参照。
export default defineConfig({
  include: [
    "src/lib/autoExportScheduler.ts",
    "src/lib/coalesce.ts",
    "src/lib/convertReplace.ts",
    "src/lib/disc.ts",
    "src/lib/dropImport.ts",
    "src/lib/errors.ts",
    "src/lib/focusTrap.ts",
    "src/lib/format.ts",
    "src/lib/genre.ts",
    "src/lib/gridRows.ts",
    "src/lib/keyedCache.ts",
    "src/lib/listKeys.ts",
    "src/lib/query.ts",
    "src/lib/relativeDate.ts",
    "src/lib/tauriEvents.ts",
    "src/lib/trackActions.ts",
    "src/lib/trackListQuery.ts",
    "src/lib/windowedList.ts",
    "src/components/infoTipPosition.ts",
    "src/components/toolbarFold.ts",
  ],
  // 仕様の要点を守るモジュール。生き残りは 0 件（kill するか理由付きで accept）でないと exit 2。
  // genre: ジャンルは空白区切りのタグ集合（docs/genre, CLAUDE.md の過去の事故）。
  // relativeDate: スマートプレイリストの相対日付条件（docs/ui-spec.md）。
  critical: ["src/lib/genre.ts", "src/lib/relativeDate.ts"],
});
