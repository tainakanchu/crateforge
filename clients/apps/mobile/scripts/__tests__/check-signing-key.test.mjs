// CheckSigningKey.java を、keytool で作った実 keystore で検査する。
// keytool / java が無い環境ではスキップする。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "CheckSigningKey.java");

const have = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const skip = !(have("keytool", ["-help"]) && have("java", ["-version"]));

const dir = skip ? "" : mkdtempSync(join(tmpdir(), "check-signing-key-"));
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const STORE_PW = "store-pw-Zq81";
const KEY_PW = "key-pw-Xv47";
const WRONG_PW = "wrong-pw-Lm23";
const ALIAS = "upload";

function makeStore(name, storetype, storepass, keypass) {
  const file = join(dir, name);
  const r = spawnSync(
    "keytool",
    ["-genkeypair", "-keystore", file, "-storetype", storetype, "-alias", ALIAS, "-keyalg", "RSA", "-keysize", "2048",
      "-validity", "30", "-dname", "CN=test", "-storepass", storepass, "-keypass", keypass],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return file;
}

function check(file, env) {
  const r = spawnSync("java", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, JAVA_HOME: process.env.JAVA_HOME, STORE_FILE: file, ...env },
  });
  const out = `${r.stdout}${r.stderr}`;
  for (const pw of [STORE_PW, KEY_PW, WRONG_PW]) assert.ok(!out.includes(pw), "password leaked into output");
  return r;
}

test("JKS (store/key パスワードが別)", { skip }, () => {
  const f = makeStore("a.jks", "JKS", STORE_PW, KEY_PW);
  const base = { STORE_PASSWORD: STORE_PW, KEY_ALIAS: ALIAS };
  const ok = check(f, { ...base, KEY_PASSWORD: KEY_PW });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /private key 'upload' readable \(RSA\)/);
  assert.equal(check(f, { ...base, KEY_PASSWORD: WRONG_PW }).status, 4);
  assert.equal(check(f, { ...base, KEY_PASSWORD: STORE_PW }).status, 4);
});

test("PKCS12 (key = store パスワード)", { skip }, () => {
  const f = makeStore("b.p12", "PKCS12", STORE_PW, STORE_PW);
  const base = { STORE_PASSWORD: STORE_PW, KEY_ALIAS: ALIAS };
  assert.equal(check(f, { ...base, KEY_PASSWORD: STORE_PW }).status, 0);
  assert.equal(check(f, { ...base, KEY_PASSWORD: WRONG_PW }).status, 4);
});

test("store パスワード違い → 2、alias 違い → 3、環境変数不足 → 64", { skip }, () => {
  const f = makeStore("c.p12", "PKCS12", STORE_PW, STORE_PW);
  assert.equal(check(f, { STORE_PASSWORD: WRONG_PW, KEY_ALIAS: ALIAS, KEY_PASSWORD: STORE_PW }).status, 2);
  assert.equal(check(f, { STORE_PASSWORD: STORE_PW, KEY_ALIAS: "nope", KEY_PASSWORD: STORE_PW }).status, 3);
  assert.equal(check(f, { STORE_PASSWORD: STORE_PW, KEY_ALIAS: ALIAS }).status, 64);
});
