// サードパーティライセンス一覧を生成して src/generated/third-party-licenses.json に書き出す。
//
// - Rust:  `cargo metadata` で依存グラフ全体（推移的含む）を取得し、各 crate の
//          ソースディレクトリから LICENSE/COPYING 等の全文を収集する。
// - JS:    `pnpm licenses list --json --prod` で配布物に含まれる prod 依存を列挙し、
//          node_modules の LICENSE 全文を収集する。
// - FFmpeg は実行時 DL の外部コンポーネントなので、手動エントリで GPL を明記する。
//
// 配布前に必ず再生成すること:  nix develop -c node scripts/gen-licenses.mjs
//
// 注: 取りこぼし防止のため依存は「多めに」列挙する方針（build/dev 由来が混ざっても
//     クレジット過多は問題にならない）。MIT/BSD/Apache 等は全文を同梱する義務がある。

import { execFileSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalText } from "./license-templates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TAURI = join(ROOT, "src-tauri");

const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE)/i;

/// ディレクトリ直下のライセンスファイル全文を連結して返す（再帰しない）。
function collectLicenseTexts(dir) {
  if (!dir || !existsSync(dir)) return "";
  let names;
  try {
    names = readdirSync(dir).filter((f) => LICENSE_FILE_RE.test(f));
  } catch {
    return "";
  }
  names.sort();
  const parts = [];
  for (const f of names) {
    const p = join(dir, f);
    try {
      if (!statSync(p).isFile()) continue;
      const txt = readFileSync(p, "utf8").trim();
      if (txt) parts.push(names.length > 1 ? `===== ${f} =====\n${txt}` : txt);
    } catch {
      /* ignore */
    }
  }
  return parts.join("\n\n");
}

/// nix シェルのバナー等が混ざっても先頭の JSON だけ取り出す。
function parseJsonLoose(s, open = "{") {
  const i = s.indexOf(open);
  return JSON.parse(i >= 0 ? s.slice(i) : s);
}

function rustDeps() {
  const out = execFileSync("cargo", ["metadata", "--format-version", "1"], {
    cwd: TAURI,
    maxBuffer: 128 * 1024 * 1024,
    encoding: "utf8",
  });
  const meta = parseJsonLoose(out);
  const workspace = new Set(meta.workspace_members || []);
  const deps = [];
  for (const pkg of meta.packages) {
    if (workspace.has(pkg.id)) continue; // 自前 crate は除外
    const dir = dirname(pkg.manifest_path);
    let text = collectLicenseTexts(dir);
    if (!text && pkg.license_file) {
      try {
        text = readFileSync(join(dir, pkg.license_file), "utf8").trim();
      } catch {
        /* ignore */
      }
    }
    const license = pkg.license || (pkg.license_file ? "See license file" : "Unknown");
    const holder = (pkg.authors && pkg.authors.join(", ")) || pkg.name;
    if (!text) text = canonicalText(license, holder) || "";
    deps.push({
      name: pkg.name,
      version: pkg.version,
      kind: "rust",
      license,
      repository: pkg.repository || pkg.homepage || null,
      text,
    });
  }
  return deps;
}

function npmAuthor(pkg) {
  const a = pkg.author;
  if (!a) return null;
  return typeof a === "string" ? a : a.name || null;
}

function npmRepo(pkg) {
  if (pkg.homepage) return pkg.homepage;
  const r = pkg.repository;
  if (!r) return null;
  return typeof r === "string" ? r : r.url || null;
}

function npmDeps() {
  const out = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
    cwd: ROOT,
    maxBuffer: 128 * 1024 * 1024,
    encoding: "utf8",
  });
  const grouped = parseJsonLoose(out);
  const deps = [];
  for (const [license, pkgs] of Object.entries(grouped)) {
    for (const pkg of pkgs) {
      const paths = pkg.paths || (pkg.path ? [pkg.path] : []);
      let text = "";
      for (const p of paths) {
        text = collectLicenseTexts(p);
        if (text) break;
      }
      const lic = pkg.license || license;
      const holder = npmAuthor(pkg) || pkg.name;
      if (!text) text = canonicalText(lic, holder) || "";
      deps.push({
        name: pkg.name,
        version: Array.isArray(pkg.versions) ? pkg.versions.join(", ") : pkg.version || "",
        kind: "npm",
        license: lic,
        repository: npmRepo(pkg),
        text,
      });
    }
  }
  return deps;
}

// 実行時に外部取得する GPL コンポーネント（cargo/npm のグラフには現れない）。
const RUNTIME_EXTRAS = [
  {
    name: "FFmpeg (BtbN win64 GPL build)",
    version: "runtime",
    kind: "runtime",
    license: "GPL-3.0-or-later",
    repository: "https://www.ffmpeg.org/legal.html",
    text:
      "FFmpeg は本アプリには同梱されません。MP3/FLAC/ALAC への変換や CD 取り込みの\n" +
      "エンコード時に、外部プロセスとして CLI を呼び出すために使用します。バイナリは\n" +
      "BtbN による公式 win64 ビルド（GPL）を上流から自動ダウンロードし、ユーザーの\n" +
      "ローカル領域に保存します（本アプリの配布物には含めず、リンクもしません = mere\n" +
      "aggregation）。FFmpeg は GPL-3.0-or-later の下で配布されています。ソースおよび\n" +
      "ライセンス全文: https://www.ffmpeg.org/  /  https://www.gnu.org/licenses/gpl-3.0.html",
  },
];

function main() {
  const selfName = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;
  const rust = rustDeps();
  const npm = npmDeps().filter((d) => d.name !== selfName);

  const merged = [...RUNTIME_EXTRAS, ...npm, ...rust];
  const seen = new Set();
  const packages = [];
  for (const d of merged) {
    const key = `${d.kind}:${d.name}:${d.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push(d);
  }
  packages.sort(
    (a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind),
  );

  const counts = {
    total: packages.length,
    rust: packages.filter((d) => d.kind === "rust").length,
    npm: packages.filter((d) => d.kind === "npm").length,
    runtime: packages.filter((d) => d.kind === "runtime").length,
    withFullText: packages.filter((d) => d.text && d.text.length > 0).length,
  };

  const outDir = join(ROOT, "src", "generated");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "third-party-licenses.json"),
    JSON.stringify({ counts, packages }, null, 2) + "\n",
  );
  console.log(
    `third-party-licenses.json: ${counts.total} packages ` +
      `(${counts.rust} rust, ${counts.npm} npm, ${counts.runtime} runtime; ` +
      `${counts.withFullText} with full text)`,
  );
}

main();
