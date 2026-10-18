#!/usr/bin/env node
// @ts-check
/**
 * android-version.mjs — GitHub 配布 APK の versionName / versionCode を決める。
 *
 * 設計: docs/android-auto/design.md §7.1
 *
 *   versionName = ルート package.json の version（= デスクトップのバージョン）
 *   versionCode = 100_000_000 + major*1_000_000 + minor*10_000 + patch*100 + (pre ? N : 99)
 *
 *   - 制約: minor, patch <= 99、プレリリースの末尾数値 N <= 98（0.. 可）。範囲外は exit 1。
 *   - プレリリース (`0.16.0-alpha.1`) は同じ x.y.z の正式版 (`…99`) より必ず小さい。
 *   - 1 億のオフセットは、EAS remote autoIncrement が発行してきた versionCode（高々数百）より
 *     必ず大きくするため。結果として以後の EAS Build 版は GitHub 版を上書きできない（意図どおり）。
 *   - 上限は Google Play と同じ 2_100_000_000（major <= 1999 相当）。
 *
 * 使い方:
 *   node android-version.mjs                       # ルート package.json から name=/code= を stdout に出力
 *   node android-version.mjs --tag v0.15.0         # さらに tag と package.json の version の一致を検証
 *   node android-version.mjs --package-json <path> # 読む package.json を差し替え（テスト用）
 *   node android-version.mjs >> "$GITHUB_OUTPUT"   # GitHub Actions の step output 形式（name=…, code=…）
 *
 * 出力はちょうど 2 行（`name=<versionName>` / `code=<versionCode>`）。診断は stderr に出す。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION_CODE_OFFSET = 100_000_000;
export const VERSION_CODE_MAX = 2_100_000_000;

/**
 * `X.Y.Z` または `X.Y.Z-<pre>`（<pre> の最後の識別子が数値）を解析する。
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, pre: number | null }}
 */
export function parseVersion(version) {
  if (typeof version !== "string") throw new Error(`version must be a string: ${String(version)}`);
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!m) {
    throw new Error(`unsupported version "${version}" (expected X.Y.Z or X.Y.Z-<pre>.N; build metadata "+…" is not allowed)`);
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  /** @type {number | null} */
  let pre = null;
  if (m[4] !== undefined) {
    const last = m[4].split(".").at(-1) ?? "";
    if (!/^(0|[1-9]\d*)$/.test(last)) {
      throw new Error(
        `pre-release "${m[4]}" of "${version}" must end with a numeric identifier (e.g. -alpha.1, -rc.2)`,
      );
    }
    pre = Number(last);
  }
  return { major, minor, patch, pre };
}

/**
 * @param {string} version
 * @returns {number}
 */
export function computeVersionCode(version) {
  const { major, minor, patch, pre } = parseVersion(version);
  if (minor > 99) throw new Error(`minor (${minor}) must be <= 99 for the versionCode scheme`);
  if (patch > 99) throw new Error(`patch (${patch}) must be <= 99 for the versionCode scheme`);
  if (pre !== null && pre > 98) throw new Error(`pre-release number (${pre}) must be <= 98 for the versionCode scheme`);
  const code = VERSION_CODE_OFFSET + major * 1_000_000 + minor * 10_000 + patch * 100 + (pre === null ? 99 : pre);
  if (!Number.isSafeInteger(code) || code > VERSION_CODE_MAX) {
    throw new Error(`versionCode ${code} exceeds the Android limit ${VERSION_CODE_MAX} (major ${major} too large)`);
  }
  return code;
}

/**
 * tag（`v0.15.0` または `0.15.0`）が version と一致することを検証する。
 * @param {string} tag
 * @param {string} version
 */
export function assertTagMatches(tag, version) {
  const bare = tag.startsWith("v") ? tag.slice(1) : tag;
  if (bare !== version) {
    throw new Error(`tag "${tag}" does not match root package.json version "${version}"`);
  }
}

/**
 * @param {{ version: string, tag?: string | null }} input
 * @returns {{ name: string, code: number }}
 */
export function compute({ version, tag = null }) {
  const code = computeVersionCode(version);
  if (tag) assertTagMatches(tag, version);
  return { name: version, code };
}

/**
 * @param {string[]} argv
 * @returns {{ tag: string | null, packageJson: string | null }}
 */
export function parseArgs(argv) {
  /** @type {{ tag: string | null, packageJson: string | null }} */
  const out = { tag: null, packageJson: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tag" || a === "--package-json") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (a === "--tag") out.tag = v;
      else out.packageJson = v;
    } else if (a.startsWith("--tag=")) {
      out.tag = a.slice("--tag=".length);
    } else if (a.startsWith("--package-json=")) {
      out.packageJson = a.slice("--package-json=".length);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  // 空文字（GitHub Actions の未設定 input）は「指定なし」とみなす。
  if (out.tag === "") out.tag = null;
  return out;
}

/** リポジトリルートの package.json（このファイルは clients/apps/mobile/scripts/ にある）。 */
export function defaultPackageJsonPath() {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "package.json"));
}

/**
 * @param {string[]} argv
 * @returns {string} stdout に出す 2 行
 */
export function run(argv) {
  const args = parseArgs(argv);
  const pkgPath = args.packageJson ?? defaultPackageJsonPath();
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const { name, code } = compute({ version: pkg.version, tag: args.tag });
  return `name=${name}\ncode=${code}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`android-version: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
