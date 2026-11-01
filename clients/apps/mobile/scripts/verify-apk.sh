#!/usr/bin/env bash
# verify-apk.sh — GitHub 配布 APK の最終検査 (docs/android-auto/design.md §7.2-7)
#
#   verify-apk.sh <apk> [options]
#
#   --expect-package <id>          期待する package（既定 com.tainakanchu.crateforge）
#   --expect-version-name <name>   期待する versionName
#   --expect-version-code <n>      期待する versionCode
#   --expect-cert <sha256>         署名証明書の SHA-256（':' 区切り・大小文字は不問）。未指定なら強制せず注意のみ
#   --reject-debug-cert            Android 標準 debug 証明書で署名されていたら失敗（署名付きビルド用の安全網）
#   --expect-runtime-version <v>   expo_runtime_version（fingerprint）の期待値（OTA 整合, 設計 R5）
#   --expect-abis <a,b,...>        lib/ 配下の ABI 集合が完全一致すること（例 arm64-v8a,armeabi-v7a）
#
# 検査内容:
#   - package / versionCode / versionName
#   - 署名: apksigner verify（v2/v3, 署名者 1 つ）+ 証明書 SHA-256（任意で期待値と一致）
#   - メディア再生サービスがちょうど 1 つ（CrateforgeMediaLibraryService, exported, mediaPlayback,
#     androidx.media3.session.MediaLibraryService + android.media.browse.MediaBrowserService）
#   - expo-audio の AudioControlsService が存在しない / MediaSessionService 系 action を持つ service が他に無い
#   - MediaButtonReceiver がちょうど 1 つ（MEDIA_BUTTON）
#   - com.google.android.gms.car.application → automotive_app_desc（<uses name="media"/> のみ）
#   - androidx.car.app.TintableAttributionIcon → 実在するリソース
#   - ArtworkProvider（exported, authorities = <package>.crateforge.artwork）
#   - android.hardware.type.automotive 等の AAOS 宣言が無い / FOREGROUND_SERVICE(_MEDIA_PLAYBACK) 権限
#   - ランチャー Activity、classes.dex、JS バンドル、ABI
#   - APK の SHA-256 を表示
#
# 必要ツール: aapt2, apksigner (Android build-tools), python3, sha256sum | shasum
#   AAPT2 / APKSIGNER 環境変数で明示可。無ければ ANDROID_HOME|ANDROID_SDK_ROOT の最新 build-tools を探す。
# 終了コード: 0 = 全て合格, 1 = 検査失敗, 2 = 使い方/ツール不足

set -uo pipefail

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

die_usage() {
  echo "verify-apk: $*" >&2
  exit 2
}

APK=""
EXPECT_PACKAGE="com.tainakanchu.crateforge"
EXPECT_VERSION_NAME=""
EXPECT_VERSION_CODE=""
EXPECT_CERT=""
EXPECT_RUNTIME=""
EXPECT_ABIS=""
REJECT_DEBUG_CERT=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage ;;
    --expect-package | --expect-version-name | --expect-version-code | --expect-cert | --expect-runtime-version | --expect-abis)
      [ $# -ge 2 ] || die_usage "$1 requires a value"
      case "$1" in
        --expect-package) EXPECT_PACKAGE="$2" ;;
        --expect-version-name) EXPECT_VERSION_NAME="$2" ;;
        --expect-version-code) EXPECT_VERSION_CODE="$2" ;;
        --expect-cert) EXPECT_CERT="$2" ;;
        --expect-runtime-version) EXPECT_RUNTIME="$2" ;;
        --expect-abis) EXPECT_ABIS="$2" ;;
      esac
      shift 2
      ;;
    --reject-debug-cert)
      REJECT_DEBUG_CERT=1
      shift
      ;;
    --*) die_usage "unknown option: $1" ;;
    *)
      [ -z "$APK" ] || die_usage "unexpected extra argument: $1"
      APK="$1"
      shift
      ;;
  esac
done

[ -n "$APK" ] || usage
[ -f "$APK" ] || die_usage "APK not found: $APK"

# ---- ツール探索 -------------------------------------------------------------
find_build_tool() {
  # $1 = tool name. PATH → ANDROID_HOME/ANDROID_SDK_ROOT の build-tools 最新版
  local name="$1" p root latest
  if p="$(command -v "$name" 2>/dev/null)"; then
    echo "$p"
    return 0
  fi
  for root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    if [ -z "$root" ] || [ ! -d "$root/build-tools" ]; then continue; fi
    latest="$(for d in "$root"/build-tools/*/; do
      [ -x "${d}${name}" ] && echo "${d}${name}"
    done | sort -V | tail -n 1)"
    if [ -n "$latest" ]; then
      echo "$latest"
      return 0
    fi
  done
  return 1
}

AAPT2="${AAPT2:-$(find_build_tool aapt2 || true)}"
APKSIGNER="${APKSIGNER:-$(find_build_tool apksigner || true)}"
if [ -z "$AAPT2" ] || [ ! -x "$AAPT2" ]; then die_usage "aapt2 not found (set AAPT2 or ANDROID_HOME with build-tools installed)"; fi
if [ -z "$APKSIGNER" ] || [ ! -x "$APKSIGNER" ]; then die_usage "apksigner not found (set APKSIGNER or ANDROID_HOME with build-tools installed)"; fi
command -v python3 >/dev/null 2>&1 || die_usage "python3 not found"

if command -v sha256sum >/dev/null 2>&1; then
  APK_SHA256="$(sha256sum "$APK" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  APK_SHA256="$(shasum -a 256 "$APK" | awk '{print $1}')"
else
  die_usage "sha256sum/shasum not found"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-apk.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
ok() { echo "[ OK ] $*"; }
note() { echo "[NOTE] $*"; }
fail() {
  echo "[FAIL] $*"
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::error title=verify-apk::$*"
  FAILS=$((FAILS + 1))
}

echo "APK    : $APK"
echo "SHA-256: $APK_SHA256"
echo "size   : $(wc -c <"$APK" | tr -d ' ') bytes"
echo

# ---- 署名 -------------------------------------------------------------------
normalize_hex() { printf '%s' "$1" | tr -d ': \t\r\n' | tr 'A-F' 'a-f'; }
# Android SDK の標準 debug.keystore (CN=Android Debug) の証明書 SHA-256。
DEBUG_CERT_SHA256="fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c"

SIGN_OUT="$WORK/apksigner.txt"
if "$APKSIGNER" verify --verbose --print-certs "$APK" >"$SIGN_OUT" 2>&1; then
  ok "apksigner verify passed"
  if grep -Eq 'Verified using v[23](\.[0-9]+)? scheme.*: true' "$SIGN_OUT"; then
    ok "signature scheme v2/v3 present ($(grep -E 'Verified using v[0-9.]+ scheme' "$SIGN_OUT" | grep ': true' | sed -E 's/^Verified using (v[0-9.]+) scheme.*/\1/' | tr '\n' ' '))"
  else
    fail "APK is not signed with v2/v3 scheme (v1-only signatures are not accepted on Android 11+ targetSdk 30+)"
  fi
  SIGNERS="$(grep -Ec '^Signer #[0-9]+ certificate SHA-256 digest:' "$SIGN_OUT" || true)"
  CERT="$(grep -E '^Signer #1 certificate SHA-256 digest:' "$SIGN_OUT" | head -n 1 | sed -E 's/.*digest:[[:space:]]*//')"
  CERT="$(normalize_hex "$CERT")"
  if [ "$SIGNERS" != "1" ] || [ -z "$CERT" ]; then
    fail "expected exactly one signer certificate, found $SIGNERS"
  else
    echo "cert SHA-256: $CERT"
    if [ -n "$EXPECT_CERT" ]; then
      if [ "$(normalize_hex "$EXPECT_CERT")" = "$CERT" ]; then
        ok "signing certificate matches the expected SHA-256"
      else
        fail "signing certificate SHA-256 mismatch (expected $(normalize_hex "$EXPECT_CERT"), got $CERT)"
      fi
    else
      note "no --expect-cert given: certificate identity is NOT enforced (set repository variable CRATEFORGE_ANDROID_CERT_SHA256)"
    fi
    if [ "$CERT" = "$DEBUG_CERT_SHA256" ]; then
      if [ "$REJECT_DEBUG_CERT" = 1 ]; then
        fail "APK is signed with the Android DEBUG certificate (release signing was not applied)"
      else
        note "APK is signed with the Android debug certificate (expected for unsigned PR builds; never distribute)"
      fi
    else
      ok "not signed with the Android debug certificate"
    fi
  fi
else
  sed 's/^/  apksigner: /' "$SIGN_OUT" >&2
  fail "apksigner verify failed"
fi

# ---- aapt2 ダンプ -----------------------------------------------------------
if ! "$AAPT2" dump xmltree --file AndroidManifest.xml "$APK" >"$WORK/manifest.txt" 2>"$WORK/aapt2.err"; then
  cat "$WORK/aapt2.err" >&2
  fail "aapt2 dump xmltree AndroidManifest.xml failed"
  echo
  echo "verify-apk: $FAILS check(s) failed" >&2
  exit 1
fi
if ! "$AAPT2" dump resources "$APK" >"$WORK/resources.txt" 2>"$WORK/aapt2.err"; then
  cat "$WORK/aapt2.err" >&2
  fail "aapt2 dump resources failed"
  : >"$WORK/resources.txt"
fi

# ---- マニフェスト / リソース / zip 構造の検査（python3） ---------------------
PY_OUT="$WORK/py.out"
AAPT2="$AAPT2" APK="$APK" WORK="$WORK" \
  EXPECT_PACKAGE="$EXPECT_PACKAGE" EXPECT_VERSION_NAME="$EXPECT_VERSION_NAME" \
  EXPECT_VERSION_CODE="$EXPECT_VERSION_CODE" EXPECT_RUNTIME="$EXPECT_RUNTIME" EXPECT_ABIS="$EXPECT_ABIS" \
  python3 -I - >"$PY_OUT" <<'PYEOF'
import os, re, subprocess, sys, zipfile

APK = os.environ["APK"]
WORK = os.environ["WORK"]
AAPT2 = os.environ["AAPT2"]
EXPECT_PACKAGE = os.environ["EXPECT_PACKAGE"]
EXPECT_VERSION_NAME = os.environ.get("EXPECT_VERSION_NAME", "")
EXPECT_VERSION_CODE = os.environ.get("EXPECT_VERSION_CODE", "")
EXPECT_RUNTIME = os.environ.get("EXPECT_RUNTIME", "")
EXPECT_ABIS = os.environ.get("EXPECT_ABIS", "")

results = []  # (status, message)
def ok(m): results.append(("OK", m))
def fail(m): results.append(("FAIL", m))
def note(m): results.append(("NOTE", m))
def check(cond, good, bad):
    (ok if cond else fail)(good if cond else bad)

# ---------------- aapt2 xmltree パーサ ----------------
class Node:
    def __init__(self, name):
        self.name = name
        self.attrs = {}      # local name -> ("str"|"ref"|"int"|"bool"|"raw", value)
        self.children = []

    def find_all(self, name):
        out = []
        for c in self.children:
            if c.name == name:
                out.append(c)
            out.extend(c.find_all(name))
        return out

    def s(self, key):
        a = self.attrs.get(key)
        return a[1] if a and a[0] == "str" else None

ATTR_RE = re.compile(r'^A: (?:(?P<ns>[^=\s(]*?):)?(?P<name>[A-Za-z_][\w.\-]*)(?:\(0x[0-9a-fA-F]+\))?=(?P<val>.*)$')
STR_RE = re.compile(r'^"((?:[^"\\]|\\.)*)"')

def parse_value(v):
    v = v.strip()
    m = STR_RE.match(v)
    if m:
        return ("str", m.group(1))
    m = re.match(r'^@(0x[0-9a-fA-F]+)', v)
    if m:
        return ("ref", m.group(1).lower())
    m = re.match(r'^@(\S+)', v)
    if m:
        return ("ref", m.group(1))
    if v.startswith("true") or v.startswith("false"):
        return ("bool", v.startswith("true"))
    m = re.match(r'^(?:\(type 0x[0-9a-fA-F]+\))?\s*(0x[0-9a-fA-F]+|-?\d+)', v)
    if m:
        t = m.group(1)
        n = int(t, 16) if t.lower().startswith("0x") else int(t)
        if "(type 0x12)" in v:  # aapt 形式の boolean
            return ("bool", n != 0)
        return ("int", n)
    return ("raw", v)

def parse_xmltree(text):
    root = Node("#root")
    stack = [(-1, root)]
    last = None
    for line in text.splitlines():
        m = re.match(r'^(\s*)([NEAC]): ?(.*)$', line)
        if not m:
            continue
        indent, kind, rest = len(m.group(1)), m.group(2), m.group(3)
        if kind == "E":
            name = re.sub(r'\s*\(line=\d+\)\s*$', '', rest).strip()
            while stack and stack[-1][0] >= indent:
                stack.pop()
            node = Node(name)
            stack[-1][1].children.append(node)
            stack.append((indent, node))
            last = node
        elif kind == "A" and last is not None:
            am = ATTR_RE.match(line.strip())
            if am:
                last.attrs[am.group("name")] = parse_value(am.group("val"))
    return root

def run_dump(args):
    p = subprocess.run([AAPT2] + args, capture_output=True, text=True)
    return p.returncode, p.stdout

def read(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()

# ---------------- resources テーブル ----------------
resources = {}  # id(lower) -> {"name": str, "values": [(config, value)]}
cur = None
for line in read(os.path.join(WORK, "resources.txt")).splitlines():
    m = re.match(r'^\s+resource (0x[0-9a-fA-F]{8}) (\S+)', line)
    if m:
        cur = {"name": m.group(2), "values": []}
        resources[m.group(1).lower()] = cur
        continue
    m = re.match(r'^\s+\(([^)]*)\) (.*)$', line)
    if m and cur is not None:
        cur["values"].append((m.group(1), m.group(2).strip()))

def res_files(rid):
    out = []
    ent = resources.get(rid)
    if not ent:
        return out
    for _cfg, val in ent["values"]:
        m = re.match(r'^\(file\) (\S+)', val)
        if m:
            out.append(m.group(1))
    return out

def res_strings(rid):
    out = []
    ent = resources.get(rid)
    if not ent:
        return out
    for _cfg, val in ent["values"]:
        m = STR_RE.match(val)
        if m:
            out.append(m.group(1))
    return out

# ---------------- マニフェスト ----------------
tree = parse_xmltree(read(os.path.join(WORK, "manifest.txt")))
manifests = [c for c in tree.children if c.name == "manifest"]
if len(manifests) != 1:
    fail("AndroidManifest.xml could not be parsed (no <manifest> element)")
    for st, m in results:
        print(f"{st}\t{m}")
    sys.exit(0)
manifest = manifests[0]

pkg = manifest.s("package")
check(pkg == EXPECT_PACKAGE, f"package = {pkg}", f"package is {pkg!r}, expected {EXPECT_PACKAGE!r}")

vc = manifest.attrs.get("versionCode")
vn = manifest.attrs.get("versionName")
vc_val = str(vc[1]) if vc and vc[0] == "int" else None
vn_val = vn[1] if vn and vn[0] == "str" else None
ok(f"versionCode = {vc_val}, versionName = {vn_val}") if vc_val and vn_val else fail(f"versionCode/versionName missing (versionCode={vc}, versionName={vn})")
if EXPECT_VERSION_CODE:
    check(vc_val == EXPECT_VERSION_CODE, f"versionCode matches expected {EXPECT_VERSION_CODE}", f"versionCode is {vc_val}, expected {EXPECT_VERSION_CODE}")
if EXPECT_VERSION_NAME:
    check(vn_val == EXPECT_VERSION_NAME, f"versionName matches expected {EXPECT_VERSION_NAME}", f"versionName is {vn_val}, expected {EXPECT_VERSION_NAME}")

application = next((c for c in manifest.children if c.name == "application"), None)
if application is None:
    fail("<application> element missing")
    for st, m in results:
        print(f"{st}\t{m}")
    sys.exit(0)

def actions(node):
    return {a.s("name") for a in node.find_all("action") if a.s("name")}

def truthy(attr):
    return bool(attr and ((attr[0] == "bool" and attr[1]) or (attr[0] == "int" and attr[1] != 0)))

MEDIA_ACTIONS = {
    "androidx.media3.session.MediaSessionService",
    "androidx.media3.session.MediaLibraryService",
    "android.media.browse.MediaBrowserService",
}
OUR_SERVICE = "com.tainakanchu.crateforge.auto.service.CrateforgeMediaLibraryService"

services = application.find_all("service")
svc_names = [s.s("name") for s in services]

check("expo.modules.audio.service.AudioControlsService" not in svc_names,
      "expo-audio AudioControlsService is absent",
      "expo-audio AudioControlsService is still declared (enableBackgroundPlayback must be false)")

media_services = [s for s in services if actions(s) & MEDIA_ACTIONS]
check(len(media_services) == 1,
      "exactly one media playback service is declared",
      f"expected exactly one media playback service, found {len(media_services)}: {[s.s('name') for s in media_services]}")

ours = [s for s in services if s.s("name") == OUR_SERVICE]
if len(ours) != 1:
    fail(f"{OUR_SERVICE} must be declared exactly once (found {len(ours)})")
else:
    svc = ours[0]
    acts = actions(svc)
    check("androidx.media3.session.MediaLibraryService" in acts, "service has action androidx.media3.session.MediaLibraryService",
          "service lacks action androidx.media3.session.MediaLibraryService")
    check("android.media.browse.MediaBrowserService" in acts, "service has action android.media.browse.MediaBrowserService",
          "service lacks action android.media.browse.MediaBrowserService (Android Auto cannot discover the app)")
    check(truthy(svc.attrs.get("exported")), "service is exported", "service must be android:exported=true")
    fgs = svc.attrs.get("foregroundServiceType")
    fgs_ok = False
    if fgs:
        if fgs[0] == "int":
            fgs_ok = bool(fgs[1] & 0x2)
        elif fgs[0] in ("str", "raw"):
            fgs_ok = "mediaPlayback" in str(fgs[1])
    check(fgs_ok, "service foregroundServiceType includes mediaPlayback", f"service foregroundServiceType does not include mediaPlayback ({fgs})")

# MediaButtonReceiver
receivers = [r for r in application.find_all("receiver") if r.s("name") == "androidx.media3.session.MediaButtonReceiver"]
if len(receivers) != 1:
    fail(f"androidx.media3.session.MediaButtonReceiver must be declared exactly once (found {len(receivers)})")
else:
    r = receivers[0]
    check("android.intent.action.MEDIA_BUTTON" in actions(r), "MediaButtonReceiver handles MEDIA_BUTTON",
          "MediaButtonReceiver lacks android.intent.action.MEDIA_BUTTON")
    check(truthy(r.attrs.get("exported")), "MediaButtonReceiver is exported", "MediaButtonReceiver must be exported")

# ArtworkProvider
providers = [p for p in application.find_all("provider") if p.s("name") == "com.tainakanchu.crateforge.auto.artwork.ArtworkProvider"]
if len(providers) != 1:
    fail(f"ArtworkProvider must be declared exactly once (found {len(providers)})")
else:
    p = providers[0]
    auth = p.s("authorities")
    check(auth == f"{pkg}.crateforge.artwork", f"ArtworkProvider authorities = {auth}",
          f"ArtworkProvider authorities is {auth!r}, expected {pkg}.crateforge.artwork")
    check(truthy(p.attrs.get("exported")), "ArtworkProvider is exported (read-only host access)", "ArtworkProvider must be exported")

# application 直下の meta-data
metas = {m.s("name"): m for m in application.find_all("meta-data") if m.s("name")}

def resolve_resource_attr(meta_name, what):
    m = metas.get(meta_name)
    if m is None:
        fail(f"meta-data {meta_name} is missing")
        return None, None
    a = m.attrs.get("resource")
    if not a or a[0] != "ref":
        fail(f"meta-data {meta_name} has no android:resource reference ({a})")
        return None, None
    rid = a[1]
    files = res_files(rid)
    ent = resources.get(rid)
    if not ent or not files:
        fail(f"{what}: resource {rid} does not resolve to a file in the APK")
        return None, None
    ok(f"{what}: {rid} -> {ent['name']} ({files[0]})")
    return rid, files

_rid, files = resolve_resource_attr("com.google.android.gms.car.application", "automotive_app_desc")
if files:
    rc, out = run_dump(["dump", "xmltree", "--file", files[0], APK])
    t = parse_xmltree(out) if rc == 0 else Node("#root")
    roots = [c for c in t.children if c.name == "automotiveApp"]
    if len(roots) != 1:
        fail(f"{files[0]} root element is not <automotiveApp>")
    else:
        uses = roots[0].find_all("uses")
        names = sorted(u.s("name") for u in uses)
        check(names == ["media"], "automotive_app_desc declares only <uses name=\"media\"/>",
              f"automotive_app_desc must declare exactly <uses name=\"media\"/> (found {names}); template/Car App Library is out of scope")

_rid, files = resolve_resource_attr("androidx.car.app.TintableAttributionIcon", "attribution icon")
if files:
    rc, out = run_dump(["dump", "xmltree", "--file", files[0], APK])
    check(rc == 0 and "vector" in out, "attribution icon is a vector drawable",
          "attribution icon is not a vector drawable (expected a single-colour <vector>)")

# AAOS / Car App Library 宣言が無い
features = [f.s("name") for f in manifest.find_all("uses-feature") if f.s("name")]
bad = [f for f in features if f in ("android.hardware.type.automotive", "android.software.car.templates_host")]
check(not bad, "no Android Automotive OS feature declarations", f"forbidden feature declaration(s): {bad}")
bad_meta = [n for n in metas if n.startswith("androidx.car.app.") and n != "androidx.car.app.TintableAttributionIcon"]
check(not bad_meta, "no Car App Library meta-data", f"Car App Library meta-data present: {bad_meta}")
bad_svc = [n for n in svc_names if n and n.startswith("androidx.car.app.")]
check(not bad_svc, "no Car App Library services", f"Car App Library service(s) present: {bad_svc}")

# 権限
perms = {p.s("name") for p in manifest.children if p.name == "uses-permission" and p.s("name")}
for perm in ("android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"):
    check(perm in perms, f"permission {perm}", f"permission {perm} missing")

# ランチャー Activity
def is_launcher(act):
    for f in act.find_all("intent-filter"):
        if "android.intent.action.MAIN" in actions(f) and "android.intent.category.LAUNCHER" in {c.s("name") for c in f.find_all("category")}:
            return True
    return False
launchers = [a.s("name") for a in application.find_all("activity") + application.find_all("activity-alias") if is_launcher(a)]
check(bool(launchers), f"launcher activity: {launchers[0] if launchers else ''}", "no MAIN/LAUNCHER activity")

# expo_runtime_version（OTA 整合）
rt_meta = metas.get("expo.modules.updates.EXPO_RUNTIME_VERSION")
rt_value = None
if rt_meta is not None:
    a = rt_meta.attrs.get("value")
    if a and a[0] == "str":
        rt_value = a[1]
    elif a and a[0] == "ref":
        vals = res_strings(a[1])
        rt_value = vals[0] if vals else None
# fingerprint ポリシーのローカルビルドでは manifest に番兵 "file:fingerprint" が入り、
# 実際の値は assets/fingerprint に埋め込まれる（expo-updates UpdatesConfiguration の
# UPDATES_CONFIGURATION_RUNTIME_VERSION_READ_FINGERPRINT_FILE_SENTINEL）。
if rt_value == "file:fingerprint":
    try:
        with zipfile.ZipFile(APK) as z:
            rt_value = z.read("assets/fingerprint").decode("utf-8").strip() or None
    except KeyError:
        rt_value = None
        fail("expo runtimeVersion is 'file:fingerprint' but assets/fingerprint is missing")
if rt_value:
    ok(f"expo runtimeVersion = {rt_value}")
else:
    (fail if EXPECT_RUNTIME else note)("expo runtimeVersion could not be read from the APK")
if EXPECT_RUNTIME and rt_value:
    check(rt_value == EXPECT_RUNTIME, "expo runtimeVersion matches the clean-checkout fingerprint (OTA compatible)",
          f"expo runtimeVersion mismatch: APK has {rt_value!r}, expected {EXPECT_RUNTIME!r} (did prebuild leave apps/mobile/package.json modified?)")

# ---------------- zip 構造 ----------------
try:
    with zipfile.ZipFile(APK) as z:
        names = z.namelist()
except Exception as e:  # noqa: BLE001
    fail(f"APK is not a readable zip: {e}")
    names = []
if names:
    check(any(re.fullmatch(r'classes\d*\.dex', n) for n in names), "classes.dex present", "classes.dex missing")
    check("assets/index.android.bundle" in names, "JS bundle (assets/index.android.bundle) embedded",
          "assets/index.android.bundle missing (not a release JS bundle build?)")
    abis = sorted({n.split("/")[1] for n in names if n.startswith("lib/") and n.count("/") >= 2})
    ok(f"native ABIs: {', '.join(abis) if abis else '(none)'}")
    if EXPECT_ABIS:
        want = sorted({a.strip() for a in EXPECT_ABIS.split(",") if a.strip()})
        check(abis == want, f"ABI set equals expected {want}", f"ABI set is {abis}, expected {want}")

for st, m in results:
    print(f"{st}\t{m}")
PYEOF
PY_RC=$?
if [ "$PY_RC" -ne 0 ]; then
  fail "internal error while inspecting the APK (python exit $PY_RC)"
fi
while IFS=$'\t' read -r status msg; do
  case "$status" in
    OK) ok "$msg" ;;
    NOTE) note "$msg" ;;
    FAIL) fail "$msg" ;;
  esac
done <"$PY_OUT"

echo
if [ "$FAILS" -gt 0 ]; then
  echo "verify-apk: $FAILS check(s) FAILED for $APK" >&2
  exit 1
fi
echo "verify-apk: all checks passed"
echo "SHA-256: $APK_SHA256  $(basename "$APK")"
