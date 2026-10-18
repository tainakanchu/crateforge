// expo-crateforge-android-auto の config plugin（design.md §6.2）。CommonJS・ビルド工程なし。
//
// 役割（service / receiver / provider / meta-data / 権限 / リソースは library manifest 側で宣言済み）:
// 1. expo-audio の Android 再生サービス（AudioControlsService）が残っていれば除去し、
//    MediaSessionService / MediaLibraryService を宣言する他のサービスが app manifest にあれば prebuild を失敗させる
//    （Android の再生サービスは CrateforgeMediaLibraryService ただ 1 つ）。
// 2. app/build.gradle 末尾に署名・version 注入ブロックを冪等に追加する。値は Gradle 実行時に
//    `-Pcrateforge.*` / `CRATEFORGE_*` 環境変数から読む（秘密値は prebuild 時に一切展開しない）。
// 3. gradle.properties の JVM メモリを RN release ビルド向けに引き上げる。
//
// plugins 配列では "expo-audio" より前に置く（mod は後ろのプラグインから先に実行されるため、
// こちらの manifest mod が expo-audio の後に走る）。

const { createRunOncePlugin, withAndroidManifest, withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

const pkg = require("../package.json");

const EXPO_AUDIO_SERVICE = "expo.modules.audio.service.AudioControlsService";
const MEDIA_SERVICE_ACTIONS = [
  "androidx.media3.session.MediaSessionService",
  "androidx.media3.session.MediaLibraryService",
  "android.media.browse.MediaBrowserService",
];
const BLOCK_BEGIN = "// @crateforge-android-auto:begin";
const BLOCK_END = "// @crateforge-android-auto:end";
const JVM_ARGS = "-Xmx4096m -XX:MaxMetaspaceSize=1024m";

function serviceActions(service) {
  const filters = service["intent-filter"] ?? [];
  return filters.flatMap((f) => (f.action ?? []).map((a) => a.$?.["android:name"]).filter(Boolean));
}

/**
 * app manifest（AndroidManifest の JSON 表現）から expo-audio の再生サービスを除き、
 * 他にメディアセッションサービスが残っていれば例外を投げる。manifest をその場で更新して返す。
 */
function removeConflictingServices(manifest) {
  const app = manifest?.manifest?.application?.[0];
  if (!app || !Array.isArray(app.service)) return manifest;
  app.service = app.service.filter((s) => s.$?.["android:name"] !== EXPO_AUDIO_SERVICE);
  const conflicts = app.service
    .filter((s) => serviceActions(s).some((a) => MEDIA_SERVICE_ACTIONS.includes(a)))
    .map((s) => s.$?.["android:name"] ?? "(unnamed)");
  if (conflicts.length > 0) {
    throw new Error(
      `[expo-crateforge-android-auto] Another media session service is declared in the app manifest: ${conflicts.join(", ")}. ` +
        "Android playback must be served only by CrateforgeMediaLibraryService (disable the other plugin's background playback).",
    );
  }
  if (app.service.length === 0) delete app.service;
  return manifest;
}

/** app/build.gradle に追記する Groovy ブロック。 */
function signingAndVersionBlock() {
  return `${BLOCK_BEGIN}
// Crateforge GitHub Releases 用の署名と version（expo-crateforge-android-auto の config plugin が生成。手で編集しない）。
// 値は Gradle 実行時に -Pcrateforge.* または CRATEFORGE_* 環境変数から読む。署名 4 項目が揃わなければ
// テンプレート既定（debug 署名）のまま。CRATEFORGE_SIGNING_REQUIRED=true で未設定ならビルドを失敗させる。
def crateforgeValue = { String prop, String env ->
  def v = project.findProperty(prop) ?: System.getenv(env)
  return (v == null || v.toString().trim().isEmpty()) ? null : v.toString().trim()
}
android {
  def cfStoreFile = crateforgeValue('crateforge.signing.storeFile', 'CRATEFORGE_SIGNING_STORE_FILE')
  def cfStorePassword = crateforgeValue('crateforge.signing.storePassword', 'CRATEFORGE_SIGNING_STORE_PASSWORD')
  def cfKeyAlias = crateforgeValue('crateforge.signing.keyAlias', 'CRATEFORGE_SIGNING_KEY_ALIAS')
  def cfKeyPassword = crateforgeValue('crateforge.signing.keyPassword', 'CRATEFORGE_SIGNING_KEY_PASSWORD')
  def cfSigningRequired = crateforgeValue('crateforge.signing.required', 'CRATEFORGE_SIGNING_REQUIRED') == 'true'
  if (cfStoreFile && cfStorePassword && cfKeyAlias && cfKeyPassword) {
    signingConfigs {
      crateforgeRelease {
        storeFile file(cfStoreFile)
        storePassword cfStorePassword
        keyAlias cfKeyAlias
        keyPassword cfKeyPassword
      }
    }
    buildTypes {
      release {
        signingConfig signingConfigs.crateforgeRelease
      }
    }
  } else if (cfSigningRequired) {
    throw new GradleException('CRATEFORGE_SIGNING_REQUIRED=true but CRATEFORGE_SIGNING_{STORE_FILE,STORE_PASSWORD,KEY_ALIAS,KEY_PASSWORD} are not all set')
  }
  def cfVersionCode = crateforgeValue('crateforge.versionCode', 'CRATEFORGE_VERSION_CODE')
  if (cfVersionCode) {
    if (!(cfVersionCode ==~ /[1-9][0-9]{0,9}/) || cfVersionCode.toLong() > 2100000000L) {
      throw new GradleException("Invalid CRATEFORGE_VERSION_CODE: \${cfVersionCode}")
    }
    defaultConfig.versionCode cfVersionCode.toInteger()
  }
  def cfVersionName = crateforgeValue('crateforge.versionName', 'CRATEFORGE_VERSION_NAME')
  if (cfVersionName) {
    defaultConfig.versionName cfVersionName
  }
}
${BLOCK_END}`;
}

/** build.gradle の内容に署名 / version ブロックを冪等に適用する（既存ブロックは置換）。 */
function applyBuildGradleBlock(contents) {
  const begin = contents.indexOf(BLOCK_BEGIN);
  const end = contents.indexOf(BLOCK_END);
  let base = contents;
  if (begin !== -1 && end !== -1 && end > begin) {
    base = contents.slice(0, begin) + contents.slice(end + BLOCK_END.length);
  }
  return `${base.replace(/\s*$/, "")}\n\n${signingAndVersionBlock()}\n`;
}

/** gradle.properties（[{type,key,value}]）に JVM 引数を設定する。 */
function applyGradleProperties(props) {
  const existing = props.find((p) => p.type === "property" && p.key === "org.gradle.jvmargs");
  if (existing) existing.value = JVM_ARGS;
  else props.push({ type: "property", key: "org.gradle.jvmargs", value: JVM_ARGS });
  return props;
}

const withCrateforgeAndroidAuto = (config) => {
  config = withAndroidManifest(config, (c) => {
    c.modResults = removeConflictingServices(c.modResults);
    return c;
  });
  config = withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== "groovy") {
      throw new Error("[expo-crateforge-android-auto] app/build.gradle must be Groovy");
    }
    c.modResults.contents = applyBuildGradleBlock(c.modResults.contents);
    return c;
  });
  config = withGradleProperties(config, (c) => {
    c.modResults = applyGradleProperties(c.modResults);
    return c;
  });
  return config;
};

module.exports = createRunOncePlugin(withCrateforgeAndroidAuto, pkg.name, pkg.version);
module.exports.removeConflictingServices = removeConflictingServices;
module.exports.applyBuildGradleBlock = applyBuildGradleBlock;
module.exports.applyGradleProperties = applyGradleProperties;
module.exports.signingAndVersionBlock = signingAndVersionBlock;
module.exports.EXPO_AUDIO_SERVICE = EXPO_AUDIO_SERVICE;
module.exports.JVM_ARGS = JVM_ARGS;
