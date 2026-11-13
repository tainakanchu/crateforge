// node:test — `node --test packages/expo-crateforge-android-auto/plugin/__tests__`
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const plugin = require("../withCrateforgeAndroidAuto");
const { removeConflictingServices, applyBuildGradleBlock, applyGradleProperties, EXPO_AUDIO_SERVICE, JVM_ARGS } = plugin;

function manifestWith(services) {
  return { manifest: { $: {}, application: [{ $: { "android:name": ".MainApplication" }, service: services }] } };
}

function service(name, actions = []) {
  return {
    $: { "android:name": name },
    ...(actions.length ? { "intent-filter": [{ action: actions.map((a) => ({ $: { "android:name": a } })) }] } : {}),
  };
}

test("expo-audio の AudioControlsService を除去し、無関係な service は残す", () => {
  const m = manifestWith([
    service(EXPO_AUDIO_SERVICE, ["androidx.media3.session.MediaSessionService"]),
    service("com.example.SyncService"),
  ]);
  const out = removeConflictingServices(m);
  assert.deepEqual(out.manifest.application[0].service.map((s) => s.$["android:name"]), ["com.example.SyncService"]);
});

test("service が AudioControlsService だけなら service 配列ごと消す", () => {
  const out = removeConflictingServices(manifestWith([service(EXPO_AUDIO_SERVICE)]));
  assert.equal(out.manifest.application[0].service, undefined);
});

test("他のメディアセッション service があれば prebuild を失敗させる", () => {
  for (const action of [
    "androidx.media3.session.MediaSessionService",
    "androidx.media3.session.MediaLibraryService",
    "android.media.browse.MediaBrowserService",
  ]) {
    assert.throws(
      () => removeConflictingServices(manifestWith([service("com.other.PlaybackService", [action])])),
      /com\.other\.PlaybackService/,
    );
  }
});

test("application / service が無い manifest はそのまま", () => {
  const m = { manifest: { $: {} } };
  assert.equal(removeConflictingServices(m), m);
  const m2 = { manifest: { application: [{ $: {} }] } };
  assert.deepEqual(removeConflictingServices(m2), m2);
});

const TEMPLATE = `android {
    defaultConfig {
        versionCode 1
        versionName "0.1.0"
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;

test("build.gradle ブロックは冪等（2 回適用しても同一）", () => {
  const once = applyBuildGradleBlock(TEMPLATE);
  const twice = applyBuildGradleBlock(once);
  assert.equal(twice, once);
  assert.equal(once.split("// @crateforge-android-auto:begin").length - 1, 1);
  assert.ok(once.startsWith(TEMPLATE.trimEnd()));
});

test("既存（古い内容の）ブロックは置換される", () => {
  const stale = `${TEMPLATE}\n// @crateforge-android-auto:begin\nold stuff\n// @crateforge-android-auto:end\n`;
  const out = applyBuildGradleBlock(stale);
  assert.ok(!out.includes("old stuff"));
  assert.equal(out, applyBuildGradleBlock(TEMPLATE));
});

test("署名 / version は Gradle 実行時に property / 環境変数から読み、秘密値を埋め込まない", () => {
  const out = applyBuildGradleBlock(TEMPLATE);
  for (const name of [
    "CRATEFORGE_SIGNING_STORE_FILE",
    "CRATEFORGE_SIGNING_STORE_PASSWORD",
    "CRATEFORGE_SIGNING_KEY_ALIAS",
    "CRATEFORGE_SIGNING_KEY_PASSWORD",
    "CRATEFORGE_SIGNING_REQUIRED",
    "CRATEFORGE_VERSION_CODE",
    "CRATEFORGE_VERSION_NAME",
    "crateforge.signing.storeFile",
    "crateforge.versionCode",
  ]) {
    assert.ok(out.includes(name), name);
  }
  assert.match(out, /signingConfig signingConfigs\.crateforgeRelease/);
  assert.match(out, /throw new GradleException/);
  // prebuild 時の環境変数は展開されない（fingerprint を汚さない）。
  process.env.CRATEFORGE_SIGNING_STORE_PASSWORD = "do-not-leak";
  try {
    assert.ok(!applyBuildGradleBlock(TEMPLATE).includes("do-not-leak"));
  } finally {
    delete process.env.CRATEFORGE_SIGNING_STORE_PASSWORD;
  }
});

test("gradle.properties の JVM 引数を設定 / 置換する", () => {
  const props = [
    { type: "comment", value: "x" },
    { type: "property", key: "org.gradle.jvmargs", value: "-Xmx2048m -XX:MaxMetaspaceSize=512m" },
  ];
  applyGradleProperties(props);
  assert.equal(props.filter((p) => p.key === "org.gradle.jvmargs").length, 1);
  assert.equal(props[1].value, JVM_ARGS);
  const empty = applyGradleProperties([]);
  assert.deepEqual(empty, [{ type: "property", key: "org.gradle.jvmargs", value: JVM_ARGS }]);
});

test("plugin は関数として export され、純関数も公開される", () => {
  assert.equal(typeof plugin, "function");
  assert.equal(typeof require("../../app.plugin.js"), "function");
});

test("app.config.ts: plugin 順序 / expo-audio 背景再生無効 / OTA チャネル production", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../../../apps/mobile/app.config.ts"), "utf8");
  const plugins = src.slice(src.indexOf("plugins: ["));
  const ours = plugins.indexOf('"expo-crateforge-android-auto"');
  const audio = plugins.indexOf('"expo-audio"');
  assert.ok(ours > 0 && audio > 0, "both plugins listed");
  assert.ok(ours < audio, "expo-crateforge-android-auto must come before expo-audio");
  assert.match(plugins, /\["expo-audio",\s*\{\s*enableBackgroundPlayback:\s*false/);
  assert.match(src, /requestHeaders:\s*\{\s*"expo-channel-name":\s*"production"\s*\}/);
});
