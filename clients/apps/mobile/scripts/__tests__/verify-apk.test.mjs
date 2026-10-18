// verify-apk.sh を、aapt2 / apksigner のスタブと合成 APK(zip) で検査する。
// 実 APK での検証は CI (android-apk.yml) と N の統合手順で行う。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "verify-apk.sh");

const have = (cmd, args = ["--version"]) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const skip = !(have("bash") && have("python3"));

const PKG = "com.tainakanchu.crateforge";
const CERT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const DEBUG_CERT = "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C";
const NS = "http://schemas.android.com/apk/res/android";

const a = (name, id, value) => `A: ${NS}:${name}(${id})=${value}`;
const s = (v) => `"${v}" (Raw: "${v}")`;

/** 手書きの aapt2 `dump xmltree` 風マニフェスト。overrides で壊した変種を作る。 */
function manifest(o = {}) {
  const pkg = o.pkg ?? PKG;
  const lines = [];
  const E = (depth, text) => lines.push(`${" ".repeat(2 + depth * 2)}E: ${text} (line=1)`);
  const A = (depth, text) => lines.push(`${" ".repeat(2 + depth * 2)}${text}`);
  lines.push(`N: android=${NS} (line=2)`);
  E(0, "manifest");
  A(1, a("versionCode", "0x0101021b", o.versionCodeAttr ?? "100150099"));
  A(1, a("versionName", "0x0101021c", s(o.versionName ?? "0.15.0")));
  A(1, `A: package=${s(pkg)}`);
  const perms = o.perms ?? ["android.permission.INTERNET", "android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"];
  for (const p of perms) {
    E(1, "uses-permission");
    A(2, a("name", "0x01010003", s(p)));
  }
  for (const f of o.features ?? []) {
    E(1, "uses-feature");
    A(2, a("name", "0x01010003", s(f)));
  }
  E(1, "application");
  A(2, a("name", "0x01010003", s("com.tainakanchu.crateforge.MainApplication")));
  // activity
  E(2, "activity");
  A(3, a("name", "0x01010003", s(".MainActivity")));
  if (!o.noLauncher) {
    E(3, "intent-filter");
    E(4, "action");
    A(5, a("name", "0x01010003", s("android.intent.action.MAIN")));
    E(4, "category");
    A(5, a("name", "0x01010003", s("android.intent.category.LAUNCHER")));
  }
  // meta-data
  if (!o.noCarMeta) {
    E(2, "meta-data");
    A(3, a("name", "0x01010003", s("com.google.android.gms.car.application")));
    A(3, a("resource", "0x01010025", "@0x7f130000"));
  }
  if (!o.noAttrMeta) {
    E(2, "meta-data");
    A(3, a("name", "0x01010003", s("androidx.car.app.TintableAttributionIcon")));
    A(3, a("resource", "0x01010025", "@0x7f080001"));
  }
  for (const extra of o.extraMeta ?? []) {
    E(2, "meta-data");
    A(3, a("name", "0x01010003", s(extra)));
    A(3, a("value", "0x01010024", s("x")));
  }
  if (o.runtime !== null) {
    E(2, "meta-data");
    A(3, a("name", "0x01010003", s("expo.modules.updates.EXPO_RUNTIME_VERSION")));
    A(3, a("value", "0x01010024", o.runtimeLiteral ? s(o.runtimeLiteral) : "@0x7f12001a"));
  }
  const service = (name, acts, { exported = "true", fgs = "2" } = {}) => {
    E(2, "service");
    A(3, a("name", "0x01010003", s(name)));
    A(3, a("exported", "0x01010010", exported));
    if (fgs !== null) A(3, a("foregroundServiceType", "0x01010599", fgs));
    E(3, "intent-filter");
    for (const act of acts) {
      E(4, "action");
      A(5, a("name", "0x01010003", s(act)));
    }
  };
  if (!o.noOurService) {
    service("com.tainakanchu.crateforge.auto.service.CrateforgeMediaLibraryService", o.ourActions ?? ["androidx.media3.session.MediaLibraryService", "android.media.browse.MediaBrowserService"], {
      exported: o.exported ?? "true",
      fgs: o.fgs === undefined ? "2" : o.fgs,
    });
  }
  if (o.audioControls) service("expo.modules.audio.service.AudioControlsService", ["androidx.media3.session.MediaSessionService"], { exported: "false" });
  if (o.otherMediaService) service("com.example.OtherService", ["androidx.media3.session.MediaSessionService"]);
  if (o.carAppService) service("androidx.car.app.CarAppService", ["androidx.car.app.CarAppService"]);
  if (!o.noReceiver) {
    E(2, "receiver");
    A(3, a("name", "0x01010003", s("androidx.media3.session.MediaButtonReceiver")));
    A(3, a("exported", "0x01010010", "true"));
    E(3, "intent-filter");
    E(4, "action");
    A(5, a("name", "0x01010003", s("android.intent.action.MEDIA_BUTTON")));
    if (o.twoReceivers) {
      E(2, "receiver");
      A(3, a("name", "0x01010003", s("androidx.media3.session.MediaButtonReceiver")));
    }
  }
  if (!o.noProvider) {
    E(2, "provider");
    A(3, a("name", "0x01010003", s("com.tainakanchu.crateforge.auto.artwork.ArtworkProvider")));
    A(3, a("authorities", "0x01010018", s(o.authority ?? `${pkg}.crateforge.artwork`)));
    A(3, a("exported", "0x01010010", "true"));
  }
  return lines.join("\n") + "\n";
}

function resources(o = {}) {
  return `Package name=${PKG} id=7f
  type drawable id=08 entryCount=2
    resource 0x7f080001 drawable/ic_crateforge_car_attribution
      () (file) res/drawable/ic_crateforge_car_attribution.xml type=XML
      (v21) (file) res/drawable-v21/ic_crateforge_car_attribution.xml type=XML
  type string id=12 entryCount=2
    resource 0x7f12001a string/expo_runtime_version
      () "${o.runtime ?? "abc123fingerprint"}"
    resource 0x7f12001b string/app_name
      () "Crateforge"
  type xml id=13 entryCount=1
    resource 0x7f130000 xml/automotive_app_desc
      () (file) res/xml/automotive_app_desc.xml type=XML
`;
}

function automotive(uses = ["media"]) {
  return `N: android=${NS} (line=1)
  E: automotiveApp (line=2)
${uses.map((u) => `    E: uses (line=3)\n      A: name="${u}" (Raw: "${u}")`).join("\n")}
`;
}

const ATTRIBUTION = `N: android=${NS} (line=2)
  E: vector (line=2)
    A: ${NS}:width(0x01010159)=24.0dip
    E: path (line=8)
`;

function apksignerOut(cert = CERT, { signers = 1, v2 = true } = {}) {
  let out = `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): ${v2}
Verified using v3 scheme (APK Signature Scheme v3): false
Number of signers: ${signers}
`;
  for (let i = 1; i <= signers; i++) {
    out += `Signer #${i} certificate DN: CN=Crateforge
Signer #${i} certificate SHA-256 digest: ${cert.replaceAll(":", "").toLowerCase()}
Signer #${i} certificate SHA-1 digest: 0000000000000000000000000000000000000000
`;
  }
  return out;
}

function build(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-apk-test-"));
  const fx = join(dir, "fx");
  spawnSync("mkdir", ["-p", fx]);
  writeFileSync(join(fx, "manifest.txt"), manifest(opts.manifest));
  writeFileSync(join(fx, "resources.txt"), resources(opts.resources));
  writeFileSync(join(fx, "automotive.txt"), automotive(opts.uses));
  writeFileSync(join(fx, "attribution.txt"), opts.attribution ?? ATTRIBUTION);
  writeFileSync(join(fx, "apksigner.txt"), opts.apksigner ?? apksignerOut(opts.cert));
  const aapt2 = join(dir, "aapt2");
  writeFileSync(
    aapt2,
    `#!/usr/bin/env bash
FX="${fx}"
if [ "$1 $2" = "dump xmltree" ]; then
  case "$4" in
    AndroidManifest.xml) cat "$FX/manifest.txt" ;;
    res/xml/automotive_app_desc.xml) cat "$FX/automotive.txt" ;;
    res/drawable/ic_crateforge_car_attribution.xml) cat "$FX/attribution.txt" ;;
    *) echo "unknown file $4" >&2; exit 1 ;;
  esac
elif [ "$1 $2" = "dump resources" ]; then
  cat "$FX/resources.txt"
else
  echo "unsupported: $*" >&2; exit 1
fi
`,
  );
  chmodSync(aapt2, 0o755);
  const apksigner = join(dir, "apksigner");
  writeFileSync(apksigner, `#!/usr/bin/env bash\ncat "${fx}/apksigner.txt"\nexit ${opts.signerRc ?? 0}\n`);
  chmodSync(apksigner, 0o755);
  const apk = join(dir, "app-release.apk");
  const files = opts.zipFiles ?? ["AndroidManifest.xml", "classes.dex", "assets/index.android.bundle", "lib/arm64-v8a/libfoo.so"];
  const py = `import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], 'w')\nfor n in sys.argv[2:]:\n    z.writestr(n, b'x')\nz.close()\n`;
  const r = spawnSync("python3", ["-c", py, apk, ...files]);
  assert.equal(r.status, 0, String(r.stderr));
  return { dir, apk, aapt2, apksigner };
}

function verify(opts = {}, args = []) {
  const b = build(opts);
  const r = spawnSync("bash", [SCRIPT, b.apk, ...args], {
    encoding: "utf8",
    env: { ...process.env, AAPT2: b.aapt2, APKSIGNER: b.apksigner, GITHUB_ACTIONS: "" },
  });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
}

const GOOD_ARGS = ["--expect-version-name", "0.15.0", "--expect-version-code", "100150099", "--expect-cert", CERT, "--expect-runtime-version", "abc123fingerprint", "--expect-abis", "arm64-v8a"];

test("passes on a well-formed APK and prints its SHA-256", { skip }, () => {
  const r = verify({}, GOOD_ARGS);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^SHA-256: [0-9a-f]{64}$/m);
  assert.match(r.stdout, /all checks passed/);
  assert.match(r.stdout, /exactly one media playback service/);
  assert.match(r.stdout, /AudioControlsService is absent/);
});

test("passes without optional expectations (cert not enforced is a NOTE)", { skip }, () => {
  const r = verify();
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /certificate identity is NOT enforced/);
});

test("accepts aapt-style int encodings (hex versionCode)", { skip }, () => {
  const r = verify({ manifest: { versionCodeAttr: `(type 0x10)0x${(100150099).toString(16)}` } }, ["--expect-version-code", "100150099"]);
  assert.equal(r.status, 0, r.out);
});

const FAIL_CASES = [
  ["wrong package", { manifest: { pkg: "com.example.other" } }, [], /package is 'com.example.other'/],
  ["version code mismatch", {}, ["--expect-version-code", "100150098"], /versionCode is 100150099, expected 100150098/],
  ["version name mismatch", {}, ["--expect-version-name", "0.15.1"], /versionName is 0.15.0/],
  ["cert mismatch", {}, ["--expect-cert", "00".repeat(32)], /certificate SHA-256 mismatch/],
  ["debug cert rejected when requested", { cert: DEBUG_CERT }, ["--reject-debug-cert"], /signed with the Android DEBUG certificate/],
  ["apksigner failure", { signerRc: 1, apksigner: "DOES NOT VERIFY\n" }, [], /apksigner verify failed/],
  ["no v2/v3 signature", { apksigner: apksignerOut(CERT, { v2: false }) }, [], /not signed with v2\/v3/],
  ["two signers", { apksigner: apksignerOut(CERT, { signers: 2 }) }, [], /exactly one signer/],
  ["AudioControlsService present", { manifest: { audioControls: true } }, [], /AudioControlsService is still declared/],
  ["second media service", { manifest: { otherMediaService: true } }, [], /exactly one media playback service, found 2/],
  ["our service missing", { manifest: { noOurService: true } }, [], /CrateforgeMediaLibraryService must be declared exactly once/],
  ["missing MediaBrowserService action", { manifest: { ourActions: ["androidx.media3.session.MediaLibraryService"] } }, [], /lacks action android.media.browse.MediaBrowserService/],
  ["missing MediaLibraryService action", { manifest: { ourActions: ["android.media.browse.MediaBrowserService", "androidx.media3.session.MediaSessionService"] } }, [], /lacks action androidx.media3.session.MediaLibraryService/],
  ["service not exported", { manifest: { exported: "false" } }, [], /android:exported=true/],
  ["service without mediaPlayback fgs type", { manifest: { fgs: "1" } }, [], /does not include mediaPlayback/],
  ["no receiver", { manifest: { noReceiver: true } }, [], /MediaButtonReceiver must be declared exactly once \(found 0\)/],
  ["two receivers", { manifest: { twoReceivers: true } }, [], /MediaButtonReceiver must be declared exactly once \(found 2\)/],
  ["no provider", { manifest: { noProvider: true } }, [], /ArtworkProvider must be declared exactly once/],
  ["wrong provider authority", { manifest: { authority: "x.y.z" } }, [], /ArtworkProvider authorities is/],
  ["no car meta-data", { manifest: { noCarMeta: true } }, [], /meta-data com.google.android.gms.car.application is missing/],
  ["no attribution meta-data", { manifest: { noAttrMeta: true } }, [], /meta-data androidx.car.app.TintableAttributionIcon is missing/],
  ["template in automotive_app_desc", { uses: ["media", "template"] }, [], /must declare exactly <uses name="media"\/>/],
  ["only template in automotive_app_desc", { uses: ["template"] }, [], /must declare exactly/],
  ["attribution icon not a vector", { attribution: `N: android=${NS} (line=1)\n  E: bitmap (line=1)\n` }, [], /not a vector drawable/],
  ["AAOS feature", { manifest: { features: ["android.hardware.type.automotive"] } }, [], /forbidden feature declaration/],
  ["Car App Library service", { manifest: { carAppService: true } }, [], /Car App Library service/],
  ["Car App Library meta-data", { manifest: { extraMeta: ["androidx.car.app.minCarApiLevel"] } }, [], /Car App Library meta-data/],
  ["missing media FGS permission", { manifest: { perms: ["android.permission.FOREGROUND_SERVICE"] } }, [], /FOREGROUND_SERVICE_MEDIA_PLAYBACK missing/],
  ["no launcher", { manifest: { noLauncher: true } }, [], /no MAIN\/LAUNCHER activity/],
  ["runtime version mismatch", { resources: { runtime: "other" } }, ["--expect-runtime-version", "abc123fingerprint"], /runtimeVersion mismatch/],
  ["runtime version unreadable but expected", { manifest: { runtime: null } }, ["--expect-runtime-version", "x"], /runtimeVersion could not be read/],
  ["missing JS bundle", { zipFiles: ["AndroidManifest.xml", "classes.dex", "lib/arm64-v8a/libfoo.so"] }, [], /index.android.bundle missing/],
  ["missing dex", { zipFiles: ["AndroidManifest.xml", "assets/index.android.bundle"] }, [], /classes.dex missing/],
  ["unexpected ABI set", { zipFiles: ["classes.dex", "assets/index.android.bundle", "lib/arm64-v8a/a.so", "lib/x86_64/a.so"] }, ["--expect-abis", "arm64-v8a"], /ABI set is/],
];

for (const [name, opts, args, re] of FAIL_CASES) {
  test(`fails: ${name}`, { skip }, () => {
    const r = verify(opts, args);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[FAIL\]/);
    assert.match(r.out, re, r.out);
  });
}

test("literal runtimeVersion string in the manifest is accepted", { skip }, () => {
  const r = verify({ manifest: { runtimeLiteral: "lit-1" } }, ["--expect-runtime-version", "lit-1"]);
  assert.equal(r.status, 0, r.out);
});

test("usage errors exit 2", { skip }, () => {
  const none = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
  assert.equal(none.status, 2);
  const missing = spawnSync("bash", [SCRIPT, "/nonexistent.apk"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  const bad = spawnSync("bash", [SCRIPT, "--bogus", "x"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("emits GitHub annotations when running in Actions", { skip }, () => {
  const b = build({ manifest: { pkg: "com.example.other" } });
  const r = spawnSync("bash", [SCRIPT, b.apk], {
    encoding: "utf8",
    env: { ...process.env, AAPT2: b.aapt2, APKSIGNER: b.apksigner, GITHUB_ACTIONS: "true" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error title=verify-apk::package is 'com.example.other'/m);
});
