import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { createCoalescer } from "../../src/lib/coalesce.ts";

type Info = { artworkChanged: boolean };
afterEach(() => {
  vi.useRealTimers();
});

const merge = (a: Info, b: Info): Info => ({ artworkChanged: a.artworkChanged || b.artworkChanged });

test("createCoalescer: 単発の通知はその場で実行する", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
  const fired: Info[] = [];
  const c = createCoalescer<Info>((v) => fired.push(v), merge, 300);
  c.push({ artworkChanged: false });
  assert.deepEqual(fired, [{ artworkChanged: false }]);
  // 窓が明けた後の単発も遅れない。
  vi.advanceTimersByTime(300);
  c.push({ artworkChanged: true });
  assert.deepEqual(fired, [{ artworkChanged: false }, { artworkChanged: true }]);
});

test("createCoalescer: 窓の中の連続した通知は窓の終わりに 1 回だけ、フラグを OR して実行する", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
  const fired: Info[] = [];
  const c = createCoalescer<Info>((v) => fired.push(v), merge, 300);
  c.push({ artworkChanged: false }); // 先頭
  for (let i = 0; i < 50; i++) {
    vi.advanceTimersByTime(2);
    c.push({ artworkChanged: i === 10 });
  }
  assert.equal(fired.length, 1);
  vi.advanceTimersByTime(300);
  assert.deepEqual(fired, [{ artworkChanged: false }, { artworkChanged: true }]);
  // 末尾の後は保留が無いので何も起きない。
  vi.advanceTimersByTime(1000);
  assert.equal(fired.length, 2);
});

test("createCoalescer: cancel で保留中の末尾の実行を取り消す", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
  let count = 0;
  const c = createCoalescer<Info>(() => count++, merge, 300);
  c.push({ artworkChanged: false });
  c.push({ artworkChanged: false });
  c.cancel();
  vi.advanceTimersByTime(1000);
  assert.equal(count, 1);
});
