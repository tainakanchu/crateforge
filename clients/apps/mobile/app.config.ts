import type { ExpoConfig } from "expo/config";

// Crateforge モバイルクライアント。app.json は廃し、ここを単一の真実とする。
// 要点:
// - Android 9+ の cleartext 既定禁止を expo-build-properties で解除（LAN http 接続のため）。
// - 背景再生: iOS は UIBackgroundModes=audio、Android は expo-audio プラグインが
//   foreground service / 通知権限を付与する。
// - QR 接続のため expo-camera にカメラ権限文言を渡す。

const config: ExpoConfig = {
  name: "Crateforge",
  slug: "crateforge",
  version: "0.1.0",
  // EAS プロジェクト（@tainakanchu/crateforge）。動的設定なので projectId は手動で持つ。
  owner: "tainakanchu",
  extra: {
    eas: {
      projectId: "e7530a3f-f8cd-4569-a543-58469097cb3e",
    },
  },
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "crateforge",
  userInterfaceStyle: "dark",
  // EAS Update（OTA）。JS/アセットの変更は再ビルド無しで配信。
  // fingerprint ポリシー = ネイティブ構成のフィンガープリントから runtimeVersion を自動算出し、
  // ネイティブが変わった時だけ OTA を無効化（=再ビルド必須）にする安全な方式。
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: "https://u.expo.dev/e7530a3f-f8cd-4569-a543-58469097cb3e",
  },
  ios: {
    bundleIdentifier: "com.tainakanchu.crateforge",
    supportsTablet: true,
    icon: "./assets/expo.icon",
    infoPlist: {
      // 背景再生（ロック中も継続）。
      UIBackgroundModes: ["audio"],
    },
  },
  android: {
    package: "com.tainakanchu.crateforge",
    adaptiveIcon: {
      // 背景は単色（teal-dark）、前景は Crateforge のダイヤモンドマーク。
      backgroundColor: "#0E1416",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#0E1416",
        android: {
          image: "./assets/images/splash-icon.png",
          imageWidth: 76,
        },
      },
    ],
    "expo-secure-store",
    "expo-audio",
    [
      "expo-camera",
      {
        cameraPermission: "接続用 QR コードを読み取るためにカメラを使用します。",
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          // LAN の http（平文）でデスクトップ API に接続するため許可。
          usesCleartextTraffic: true,
        },
      },
    ],
  ],
  experiments: {
    // typedRoutes は expo を起動して型生成しないと未登録ルートで誤検知するため OFF。
    // （CI/ローカルの tsc 検証を安定させる。href は string 扱いになる。）
    typedRoutes: false,
    reactCompiler: true,
  },
};

export default config;
