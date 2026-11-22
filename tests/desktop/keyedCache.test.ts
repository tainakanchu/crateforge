import { test } from "vitest";
import assert from "node:assert/strict";
import { KeyedCache } from "../../src/lib/keyedCache.ts";

/** テストから応答のタイミングを決められる取得。 */
function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("load: 取得して覚え、2 回目は取得しない。同時の取得は 1 回にまとめる", async () => {
  let changes = 0;
  const c = new KeyedCache<string[]>(() => changes++);
  let calls = 0;
  const fetch = async () => {
    calls++;
    return ["a"];
  };
  const [x, y] = await Promise.all([c.load("k", fetch), c.load("k", fetch)]);
  assert.deepEqual(x, ["a"]);
  assert.equal(x, y);
  assert.equal(calls, 1);
  await c.load("k", fetch);
  assert.equal(calls, 1);
  assert.deepEqual(c.get("k"), ["a"]);
  assert.equal(changes, 1);
});

test("markAllStale: 値は表示用に残し、次の load で取り直す", async () => {
  const c = new KeyedCache<string>();
  await c.load("k", async () => "old");
  c.markAllStale();
  assert.equal(c.get("k"), "old");
  assert.equal(await c.load("k", async () => "new"), "new");
  assert.equal(c.get("k"), "new");
});

test("reset: 切り替え前に始めた取得の結果は覚えない (同じキーでも範囲が違えば中身が違う)", async () => {
  const c = new KeyedCache<string>();
  const slow = deferred<string>();
  const p = c.load("album", () => slow.promise); // 前の一覧 (プレイリスト A) での取得
  c.reset(); // プレイリスト B へ切り替え
  slow.resolve("tracks of A");
  assert.equal(await p, "tracks of A", "待っていた呼び出し元には返る");
  assert.equal(c.get("album"), undefined, "新しい一覧のキャッシュには入れない");
  assert.equal(await c.load("album", async () => "tracks of B"), "tracks of B");
  assert.equal(c.get("album"), "tracks of B");
});

test("markAllStale: 取り直し前に始めた取得の結果も覚えない", async () => {
  const c = new KeyedCache<string>();
  const slow = deferred<string>();
  const p = c.load("k", () => slow.promise);
  c.markAllStale();
  slow.resolve("before change");
  await p;
  assert.equal(c.get("k"), undefined);
});

test("失敗: isFailed になり、次の load で取り直せる", async () => {
  let changes = 0;
  const c = new KeyedCache<string>(() => changes++);
  await assert.rejects(c.load("k", async () => Promise.reject(new Error("boom"))));
  assert.equal(c.isFailed("k"), true);
  const before = changes;
  const p = c.load("k", async () => "ok");
  assert.equal(c.isFailed("k"), false, "再試行中は失敗の表示を消す");
  assert.ok(changes > before);
  assert.equal(await p, "ok");
});

test("update: 覚えている値だけ書き換える。同じ値なら通知しない", async () => {
  let changes = 0;
  const c = new KeyedCache<number[]>(() => changes++);
  await c.load("k", async () => [1, 2]);
  changes = 0;
  c.update("k", (v) => v);
  c.update("missing", (v) => [...v, 9]);
  assert.equal(changes, 0);
  c.update("k", (v) => [...v, 3]);
  assert.deepEqual(c.get("k"), [1, 2, 3]);
  assert.equal(changes, 1);
  assert.deepEqual(c.keys(), ["k"]);
});

test("markAllStale のあと取り直した値は新しい扱いになり、次の load では取らない", async () => {
  const c = new KeyedCache<string>();
  await c.load("k", async () => "old");
  c.markAllStale();
  let calls = 0;
  const fetch = async () => {
    calls++;
    return "new";
  };
  await c.load("k", fetch);
  await c.load("k", fetch);
  assert.equal(calls, 1);
});

test("markAllStale: 取り直し前に始めた取得は待たず、新しく取得する", async () => {
  const c = new KeyedCache<string>();
  const slow = deferred<string>();
  void c.load("k", () => slow.promise);
  c.markAllStale();
  let calls = 0;
  const p = c.load("k", async () => {
    calls++;
    return "after change";
  });
  assert.equal(calls, 1);
  assert.equal(await p, "after change");
  slow.resolve("before change");
});

test("reset / markAllStale を重ねても、その前に始めた取得の結果は覚えない", async () => {
  for (const order of [["stale", "reset"], ["reset", "stale"]] as const) {
    const c = new KeyedCache<string>();
    const slow = deferred<string>();
    const p = c.load("k", () => slow.promise);
    for (const op of order) {
      if (op === "stale") c.markAllStale();
      else c.reset();
    }
    slow.resolve("old");
    await p;
    assert.equal(c.get("k"), undefined, order.join(" → "));
  }
});

test("失敗の通知: 失敗したら 1 回通知する。切り替え前に始めた取得の失敗は記録しない", async () => {
  let changes = 0;
  const c = new KeyedCache<string>(() => changes++);
  await assert.rejects(c.load("k", async () => Promise.reject(new Error("boom"))));
  assert.equal(changes, 1);

  const c2 = new KeyedCache<string>(() => changes++);
  const slow = deferred<string>();
  const p = c2.load("k", () => slow.promise);
  c2.reset();
  changes = 0;
  slow.reject(new Error("old"));
  await assert.rejects(p);
  assert.equal(c2.isFailed("k"), false);
  assert.equal(changes, 0);
});

test("reset: 値と失敗の記録を捨て、捨てるものがあったときだけ通知する", async () => {
  let changes = 0;
  const c = new KeyedCache<string>(() => changes++);
  c.reset();
  assert.equal(changes, 0, "空なら通知しない");

  await c.load("a", async () => "A");
  changes = 0;
  c.reset();
  assert.equal(changes, 1);
  assert.equal(c.get("a"), undefined);
  assert.deepEqual(c.keys(), []);

  await assert.rejects(c.load("b", async () => Promise.reject(new Error("boom"))));
  changes = 0;
  c.reset();
  assert.equal(changes, 1, "失敗だけでも通知する");
  assert.equal(c.isFailed("b"), false);
});
