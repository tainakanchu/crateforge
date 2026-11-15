import { test } from "node:test";
import assert from "node:assert/strict";
import { subscribeDisposable } from "../../src/lib/tauriEvents.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("subscribeDisposable: 確立後に解除すると unlisten が 1 回呼ばれる", async () => {
  const d = deferred<() => void>();
  let calls = 0;
  const dispose = subscribeDisposable(d.promise);
  d.resolve(() => calls++);
  await tick();
  assert.equal(calls, 0);
  dispose();
  assert.equal(calls, 1);
  dispose();
  assert.equal(calls, 1, "二重に解除しても unlisten は 1 回");
});

test("subscribeDisposable: 確立前に解除しても、確立した時点で unlisten が呼ばれる", async () => {
  const d = deferred<() => void>();
  let calls = 0;
  const dispose = subscribeDisposable(d.promise);
  dispose();
  assert.equal(calls, 0);
  d.resolve(() => calls++);
  await tick();
  assert.equal(calls, 1);
});

test("subscribeDisposable: 購読の失敗は握って解除関数は安全に呼べる", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const d = deferred<() => void>();
  const dispose = subscribeDisposable(d.promise);
  d.reject(new Error("no ipc"));
  await tick();
  assert.equal(errors.mock.callCount(), 1);
  assert.doesNotThrow(dispose);
});
