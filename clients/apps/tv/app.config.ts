import type { ExpoConfig } from "expo/config";

// Crateforge TV クライアント（Android TV / Fire TV 向け）。
// 要点:
// - Android TV の leanback ランチャーは app.plugin.js (config plugin) でマニフェストに注入する。
//   通常の Android スマホにもインストール可能（required="false"）。
// - 平文 http は expo-build-properties で許可（LAN 接続のため）。
// - QR ペアリングは TV では使えないため expo-camera は省く。
//   代わりに画面上の数字コードを手入力してペアリングする。
//
// TODO: EAS プロジェクトの初期化
//   TV アプリは電話アプリとは別の EAS プロジェクトが必要。
//   下記手順でプロジェクト ID を取得し、このファイルの PLACEHOLDER_TV_PROJECT_ID を置き換えてください:
//   1. cd clients/apps/tv
//   2. pnpm dlx eas-cli init
//   3. 生成された projectId を updates.url と extra.eas.projectId に設定する

const TV_PROJECT_ID = "PLACEHOLDER_TV_PROJECT_ID"; // TODO: eas init で取得した ID に置き換える

const config: ExpoConfig = {
  name: "Crateforge TV",
  slug: "crateforge-tv",
  version: "0.1.0",
  owner: "tainakanchu",
  // TODO: eas init 後に PLACEHOLDER_TV_PROJECT_ID を実際の projectId に置き換えること
  extra: {
    eas: {
      projectId: TV_PROJECT_ID,
    },
  },
  scheme: "crateforgetv",
  userInterfaceStyle: "dark",
  // fingerprint ポリシー = ネイティブ構成のフィンガープリントから runtimeVersion を自動算出。
  // TODO: eas init 後に updates.url の PLACEHOLDER_TV_PROJECT_ID も置き換えること
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: `https://u.expo.dev/${TV_PROJECT_ID}`,
  },
  // TV アプリは Android 専用。iOS は不要。
  android: {
    package: "com.tainakanchu.crateforge.tv",
    icon: "./assets/images/icon.png",
    // TODO: 320x180 の TV バナー画像を用意して banner に設定する（現在は icon で代用）
    // android:banner は 320×180px。アスペクト比は合わないが Android は受け入れる。
    adaptiveIcon: {
      backgroundColor: "#0E1416",
      foregroundImage: "./assets/images/icon.png",
    },
    // Android TV の leanback uses-feature と LEANBACK_LAUNCHER は
    // eas build 時に app.plugin.js（下記）で AndroidManifest.xml に注入する。
    // プレーンな APK でも Android TV にインストール・起動できる。
    intentFilters: [
      {
        action: "android.intent.action.MAIN",
        category: [
          "android.intent.category.LEANBACK_LAUNCHER",
        ],
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
    // Android TV マニフェスト追加: uses-feature leanback(required=false) + no-touchscreen
    // app.plugin.js が AndroidManifest.xml に uses-feature を注入する。
    "./app.plugin.js",
  ],
  experiments: {
    typedRoutes: false,
    reactCompiler: true,
  },
};

export default config;
