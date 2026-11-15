#!/usr/bin/env bash
# 標準入力の変更ファイル名（リポジトリルート相対、1 行 1 ファイル）に、Android ネイティブビルドへ
# 影響するものが 1 つでも含まれていれば "true"、無ければ "false" を標準出力に出す（終了コードは常に 0）。
#
# 使い方:  git diff --name-only <base>...<head> | .github/scripts/native-changed.sh
# テスト:  .github/scripts/native-changed.sh --self-test
#
# ルール（mobile.yml の changes ジョブが使う。パターンはこのファイルだけに置く）:
#   JS / TS のソース (src/ 配下など) だけの変更は Metro の bundle 検査 (js ジョブの expo export) で足りるので
#   ネイティブビルドを省く。次のいずれかに触れたら prebuild / Gradle の結果が変わり得るので true。
#     - Expo の設定・config plugin・EAS 設定・Metro/Babel 設定
#     - 依存関係 (package.json / lockfile / pnpm 設定)。ルート package.json は versionName の元
#     - 自前ネイティブモジュール (android/ ios/ plugin/ expo-module.config.json app.plugin.js)
#     - app.config が参照するアイコン・スプラッシュ・バナー画像（ネイティブリソースに焼かれる）
#       （plugin/__tests__ などテストだけは除外）
#     - APK のビルド・検査スクリプトと、このワークフロー自身
# 新しいネイティブ関連ファイルを足したら、ここに追記する。
set -euo pipefail

patterns=(
  # アプリの Expo 設定 / EAS / config plugin / バンドラ設定
  '^clients/apps/[^/]+/(app\.config\.ts|app\.json|eas\.json|app\.plugin\.js|metro\.config\.js|babel\.config\.js)$'
  '^clients/apps/[^/]+/plugins/'
  '^clients/apps/[^/]+/\.npmrc$'
  # 依存関係
  '^package\.json$'
  '^clients/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$'
  '^clients/apps/[^/]+/(package\.json|pnpm-lock\.yaml)$'
  '^clients/packages/[^/]+/package\.json$'
  # 自前ネイティブモジュール
  '^clients/packages/expo-crateforge-[^/]+/(android|ios|plugin)/'
  '^clients/packages/expo-crateforge-[^/]+/(expo-module\.config\.json|app\.plugin\.js)$'
  # app.config が参照するアイコン / スプラッシュ / TV バナー
  '^clients/apps/mobile/assets/expo\.icon/'
  '^clients/apps/mobile/assets/images/(icon|android-icon-[^/]+|splash-icon|favicon)\.png$'
  '^clients/apps/tv/assets/images/(icon|banner)\.png$'
  # APK のビルド・検査
  '^clients/apps/mobile/scripts/(android-version\.mjs|verify-apk\.sh)$'
  '^\.github/workflows/(android-apk|mobile)\.yml$'
  '^\.github/scripts/native-changed\.sh$'
)

check() {
  local joined
  joined="$(IFS='|'; echo "${patterns[*]}")"
  # __tests__ はネイティブビルドに入らない（js ジョブの node テストで検証済み）ので除外する。
  if grep -Ev -- '/__tests__/' | grep -Eq -- "$joined"; then echo true; else echo false; fi
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  t() { # 期待値 ファイル...
    local want="$1"; shift
    local got; got="$(printf '%s\n' "$@" | check)"
    if [ "$got" = "$want" ]; then echo "ok   $want  $*"; else echo "FAIL want=$want got=$got  $*"; fail=1; fi
  }
  t false clients/apps/mobile/src/app/index.tsx clients/packages/core/src/x.ts clients/apps/tv/src/a.tsx README.md
  t false clients/apps/mobile/assets/images/tabIcons/home.png clients/packages/expo-crateforge-android-auto/src/index.ts
  t false clients/packages/expo-crateforge-android-auto/plugin/__tests__/__tests__/x.test.js
  t true  clients/apps/mobile/app.config.ts
  t true  clients/apps/tv/app.plugin.js
  t true  clients/apps/mobile/src/a.ts clients/pnpm-lock.yaml
  t true  clients/packages/expo-crateforge-android-auto/android/src/main/kotlin/x.kt
  t true  clients/packages/expo-crateforge-android-auto/plugin/withCrateforgeAndroidAuto.js
  t true  clients/packages/expo-crateforge-mdns/ios/Foo.swift
  t true  clients/packages/core/package.json
  t true  clients/apps/tv/assets/images/banner.png
  t true  clients/apps/mobile/assets/images/splash-icon.png
  t true  .github/workflows/android-apk.yml
  t false .github/workflows/ci.yml
  t false ""
  exit "$fail"
fi

check
