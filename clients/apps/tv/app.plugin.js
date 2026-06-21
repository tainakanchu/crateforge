/**
 * Android TV 向け config plugin。
 * AndroidManifest.xml に以下を追加する:
 *   <uses-feature android:name="android.software.leanback" android:required="false"/>
 *   <uses-feature android:name="android.hardware.touchscreen" android:required="false"/>
 *
 * LEANBACK_LAUNCHER intent category と icon は app.config.ts の intentFilters で設定済み。
 */
const { withAndroidManifest } = require("@expo/config-plugins");

const withAndroidTV = (config) => {
  return withAndroidManifest(config, async (cfg) => {
    const androidManifest = cfg.modResults;
    const manifest = androidManifest.manifest;

    if (!manifest["uses-feature"]) {
      manifest["uses-feature"] = [];
    }

    const features = manifest["uses-feature"];
    const leanback = "android.software.leanback";
    const noTouch = "android.hardware.touchscreen";

    // 重複追加を防ぐ
    const hasLeanback = features.some((f) => f.$?.["android:name"] === leanback);
    const hasNoTouch = features.some((f) => f.$?.["android:name"] === noTouch);

    if (!hasLeanback) {
      features.push({ $: { "android:name": leanback, "android:required": "false" } });
    }
    if (!hasNoTouch) {
      features.push({ $: { "android:name": noTouch, "android:required": "false" } });
    }

    return cfg;
  });
};

module.exports = withAndroidTV;
