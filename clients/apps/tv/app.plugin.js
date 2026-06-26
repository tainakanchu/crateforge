/**
 * Android TV 向け config plugin。AndroidManifest.xml に以下を行う:
 *   - <uses-feature android:name="android.software.leanback" android:required="false"/>
 *   - <uses-feature android:name="android.hardware.touchscreen" android:required="false"/>
 *   - <application ... android:banner="@drawable/tv_banner">（leanback ランチャー必須のバナー）
 *   - assets/images/banner.png を res/drawable/tv_banner.png へコピー
 *
 * LEANBACK_LAUNCHER intent category は app.config.ts の android.intentFilters で設定する
 * （Expo が android.intent.category. を自動付与するので短縮名 "LEANBACK_LAUNCHER" を使う）。
 */
const {
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// uses-feature(leanback / no-touchscreen) を注入（required=false でスマホにも入る）
const withTvFeatures = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest["uses-feature"]) manifest["uses-feature"] = [];
    const features = manifest["uses-feature"];
    const ensure = (name) => {
      if (!features.some((f) => f.$ && f.$["android:name"] === name)) {
        features.push({
          $: { "android:name": name, "android:required": "false" },
        });
      }
    };
    ensure("android.software.leanback");
    ensure("android.hardware.touchscreen");
    return cfg;
  });

// <application android:banner="@drawable/tv_banner"> を設定
const withTvBannerAttr = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$["android:banner"] = "@drawable/tv_banner";
    return cfg;
  });

// assets/images/banner.png を res/drawable/tv_banner.png へコピー
const withTvBannerAsset = (config) =>
  withDangerousMod(config, [
    "android",
    (cfg) => {
      const src = path.join(
        cfg.modRequest.projectRoot,
        "assets",
        "images",
        "banner.png",
      );
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable",
      );
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, "tv_banner.png"));
      return cfg;
    },
  ]);

const withAndroidTV = (config) => {
  config = withTvFeatures(config);
  config = withTvBannerAttr(config);
  config = withTvBannerAsset(config);
  return config;
};

module.exports = withAndroidTV;
