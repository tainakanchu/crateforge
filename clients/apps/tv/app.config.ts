import type { ExpoConfig } from "expo/config";

// Crateforge TV クライアント（Android TV / Fire TV 向け）。
// 要点:
// - Android TV の leanback ランチャーは app.plugin.js (config plugin) でマニフェストに注入する。
//   通常の Android スマホにもインストール可能（required="false"）。
// - 平文 http は expo-build-properties で許可（LAN 接続のため）。
// - QR ペアリングは TV では使えないため expo-camera は省く。
//   代わりに画面上の数字コードを手入力してペアリングする。
//
// EAS プロジェクト: @tainakanchu/crateforge-tv
//   https://expo.dev/accounts/tainakanchu/projects/crateforge-tv
//   TV アプリは電話アプリとは別の EAS プロジェクト。projectId は eas init で取得済み。
//   この ID は updates.url と extra.eas.projectId の両方で使う。
//   再リンク/再初期化する場合: cd clients/apps/tv && pnpm exec eas init

const TV_PROJECT_ID = "e65af3bc-0400-4fb0-9de1-eb5b828869c2";

const config: ExpoConfig = {
  name: "Crateforge TV",
  slug: "crateforge-tv",
  version: "0.1.0",
  owner: "tainakanchu",
  extra: {
    eas: {
      projectId: TV_PROJECT_ID,
    },
  },
  scheme: "crateforgetv",
  userInterfaceStyle: "dark",
  // fingerprint ポリシー = ネイティブ構成のフィンガープリントから runtimeVersion を自動算出。
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: `https://u.expo.dev/${TV_PROJECT_ID}`,
  },
  // TV アプリは Android 専用。iOS は不要。
  android: {
    package: "com.tainakanchu.crateforge.tv",
    icon: "./assets/images/icon.png",
    // Android TV バナーは app.plugin.js が assets/images/banner.png（320×180）を
    // res/drawable/tv_banner.png へコピーし、application に android:banner="@drawable/tv_banner" を注入する。
    adaptiveIcon: {
      backgroundColor: "#0E1416",
      foregroundImage: "./assets/images/icon.png",
    },
    // LEANBACK_LAUNCHER ランチャーは下記 intentFilters で設定（短縮名）。
    // leanback/no-touchscreen の uses-feature と banner は app.plugin.js が注入。
    intentFilters: [
      {
        // Expo が android.intent.action. / android.intent.category. を自動付与するため短縮名で書く。
        // フル修飾名を書くと二重プレフィックスになり TV ランチャーが解決できない。
        action: "MAIN",
        category: ["LEANBACK_LAUNCHER"],
      },
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-audio",
    [
      "expo-build-properties",
      {
        android: {
          // LAN の http（平文）でデスクトップ API に接続するため許可。
          usesCleartextTraffic: true,
        },
      },
    ],
    // Android TV マニフェスト追加: uses-feature leanback(required=false) + no-touchscreen + android:banner
    // app.plugin.js が AndroidManifest.xml に uses-feature と banner を注入し、banner アセットをコピーする。
    "./app.plugin.js",
  ],
  experiments: {
    typedRoutes: false,
    reactCompiler: true,
  },
};

export default config;
