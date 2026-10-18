// node --test clients/apps/mobile/scripts/__tests__
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  VERSION_CODE_MAX,
  assertTagMatches,
  compute,
  computeVersionCode,
  defaultPackageJsonPath,
  parseArgs,
  parseVersion,
  run,
} from "../android-version.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "android-version.mjs");

function tmpPackageJson(version) {
  const dir = mkdtempSync(join(tmpdir(), "android-version-"));
  const p = join(dir, "package.json");
  writeFileSync(p, JSON.stringify({ name: "x", version }));
  return p;
}

test("formula: documented examples", () => {
  assert.equal(computeVersionCode("0.15.0"), 100_150_099);
  assert.equal(computeVersionCode("0.16.0-alpha.1"), 100_160_001);
  assert.equal(computeVersionCode("1.0.0"), 101_000_099);
  assert.equal(computeVersionCode("0.0.0"), 100_000_099);
  assert.equal(computeVersionCode("0.15.7"), 100_150_799);
  assert.equal(computeVersionCode("12.34.56"), 100_000_000 + 12_000_000 + 340_000 + 5_600 + 99);
});

test("pre-release is strictly lower than the release of the same x.y.z", () => {
  assert.ok(computeVersionCode("0.16.0-alpha.1") < computeVersionCode("0.16.0"));
  assert.ok(computeVersionCode("0.16.0-alpha.98") < computeVersionCode("0.16.0"));
  assert.ok(computeVersionCode("0.16.0-rc.0") < computeVersionCode("0.16.0-rc.1"));
});

test("pre-release uses the last numeric identifier", () => {
  assert.equal(computeVersionCode("0.7.0-alpha.1"), 100_070_001);
  assert.equal(computeVersionCode("0.7.0-beta.2.5"), 100_070_005);
  assert.equal(computeVersionCode("0.7.0-3"), 100_070_003);
});

test("monotonic over semver order for a sample of versions", () => {
  const ordered = [
    "0.14.2",
    "0.15.0-alpha.1",
    "0.15.0-alpha.2",
    "0.15.0",
    "0.15.1",
    "0.15.10",
    "0.16.0-rc.1",
    "0.16.0",
    "0.99.99",
    "1.0.0-alpha.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];
  const codes = ordered.map(computeVersionCode);
  for (let i = 1; i < codes.length; i++) {
    assert.ok(codes[i] > codes[i - 1], `${ordered[i - 1]} (${codes[i - 1]}) < ${ordered[i]} (${codes[i]})`);
  }
});

test("always above any plausible EAS autoIncrement versionCode", () => {
  assert.ok(computeVersionCode("0.0.0") > 10_000_000);
  assert.ok(computeVersionCode("0.0.0-alpha.0") > 10_000_000);
});

test("range limits", () => {
  assert.throws(() => computeVersionCode("0.100.0"), /minor/);
  assert.throws(() => computeVersionCode("0.0.100"), /patch/);
  assert.throws(() => computeVersionCode("0.1.0-alpha.99"), /pre-release number/);
  assert.equal(computeVersionCode("0.99.99"), 100_000_000 + 990_000 + 9_900 + 99);
  assert.equal(computeVersionCode("0.1.0-alpha.98"), 100_010_098);
  // major が大きすぎて Android の上限を超える
  assert.throws(() => computeVersionCode("2000.0.0"), /exceeds/);
  assert.ok(computeVersionCode("1999.99.99") <= VERSION_CODE_MAX);
});

test("rejects malformed versions", () => {
  for (const bad of ["", "1", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-alpha", "1.2.3-alpha.x", "1.2.3+build.5", "1.2.3-rc.1+b", "a.b.c", "1.2.3-01"]) {
    assert.throws(() => parseVersion(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseVersion(undefined), /string/);
  assert.throws(() => parseVersion(1.5), /string/);
});

test("parseVersion fields", () => {
  assert.deepEqual(parseVersion("3.4.5"), { major: 3, minor: 4, patch: 5, pre: null });
  assert.deepEqual(parseVersion("3.4.5-rc.7"), { major: 3, minor: 4, patch: 5, pre: 7 });
});

test("tag validation", () => {
  assert.doesNotThrow(() => assertTagMatches("v0.15.0", "0.15.0"));
  assert.doesNotThrow(() => assertTagMatches("0.15.0", "0.15.0"));
  assert.doesNotThrow(() => assertTagMatches("v0.16.0-alpha.1", "0.16.0-alpha.1"));
  assert.throws(() => assertTagMatches("v0.15.1", "0.15.0"), /does not match/);
  assert.throws(() => assertTagMatches("v0.16.0", "0.16.0-alpha.1"), /does not match/);
  assert.throws(() => assertTagMatches("refs/tags/v0.15.0", "0.15.0"), /does not match/);
});

test("compute()", () => {
  assert.deepEqual(compute({ version: "0.15.0" }), { name: "0.15.0", code: 100_150_099 });
  assert.deepEqual(compute({ version: "0.15.0", tag: "v0.15.0" }), { name: "0.15.0", code: 100_150_099 });
  assert.throws(() => compute({ version: "0.15.0", tag: "v0.15.1" }), /does not match/);
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs([]), { tag: null, packageJson: null });
  assert.deepEqual(parseArgs(["--tag", "v1.2.3"]), { tag: "v1.2.3", packageJson: null });
  assert.deepEqual(parseArgs(["--tag=v1.2.3", "--package-json=/x/package.json"]), { tag: "v1.2.3", packageJson: "/x/package.json" });
  // GitHub Actions が未設定 input を空文字で渡してきた場合は「指定なし」
  assert.deepEqual(parseArgs(["--tag", ""]), { tag: null, packageJson: null });
  assert.throws(() => parseArgs(["--tag"]), /requires a value/);
  assert.throws(() => parseArgs(["--tag", "--package-json"]), /requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("run() output format is GITHUB_OUTPUT compatible (exactly two lines)", () => {
  const out = run(["--package-json", tmpPackageJson("0.15.0")]);
  assert.equal(out, "name=0.15.0\ncode=100150099\n");
});

test("default package.json is the repository root one", () => {
  const rootPkg = JSON.parse(readFileSync(defaultPackageJsonPath(), "utf8"));
  assert.equal(rootPkg.name, "crateforge");
  const out = run([]);
  assert.match(out, new RegExp(`^name=${rootPkg.version.replace(/[.+-]/g, "\\$&")}\\ncode=\\d{9}\\n$`));
});

test("CLI: success prints name/code to stdout", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--package-json", tmpPackageJson("0.16.0-alpha.1"), "--tag", "v0.16.0-alpha.1"], {
    encoding: "utf8",
  });
  assert.equal(out, "name=0.16.0-alpha.1\ncode=100160001\n");
});

test("CLI: tag mismatch exits 1 with a diagnostic on stderr and nothing on stdout", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--package-json", tmpPackageJson("0.15.0"), "--tag", "v0.15.1"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /does not match/);
});

test("CLI: out-of-range version exits 1", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--package-json", tmpPackageJson("0.100.0")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /minor/);
});

test("CLI: unknown arg exits 1", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
});
