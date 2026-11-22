import { test } from "vitest";
import assert from "node:assert/strict";
import {
  IDLE_MS,
  MAX_WAIT_MS,
  createAutoExportScheduler,
} from "../../src/lib/autoExportScheduler.ts";

// 注入用の偽の時計とタイマー。advance(ms) で時間を進め、期限の来たタイマーを順に発火する。
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flushMicrotasks = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number);
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, tm] of timers) {
          if (tm.at <= end && tm.at < nextAt) {
            nextAt = tm.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const tm = timers.get(nextId)!;
        timers.delete(nextId);
        t = tm.at;
        tm.fn();
        await flushMicrotasks();
      }
      t = end;
      await flushMicrotasks();
    },
    pending: () => timers.size,
  };
}

function setup(run?: () => Promise<void>) {
  const clock = fakeClock();
  let runs = 0;
  const s = createAutoExportScheduler({
    run: async () => {
      runs++;
      if (run) await run();
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, s, runs: () => runs };
}

test("変更後 60 秒間なにもなければ書き出す (仕様)", async () => {
  const { clock, s, runs } = setup();
  s.markDirty();
  await clock.advance(IDLE_MS - 1);
  assert.equal(runs(), 0);
  await clock.advance(1);
  assert.equal(runs(), 1);
  assert.equal(s.isDirty(), false);
});

test("操作があるとアイドルが数え直しになる", async () => {
  const { clock, s, runs } = setup();
  s.markDirty();
  await clock.advance(50_000);
  s.noteInput();
  await clock.advance(50_000);
  assert.equal(runs(), 0, "最後の操作から 60 秒経っていない");
  await clock.advance(10_000);
  assert.equal(runs(), 1);
});

test("追加の変更でもアイドルが数え直しになる", async () => {
  const { clock, s, runs } = setup();
  s.markDirty();
  await clock.advance(40_000);
  s.markDirty();
  await clock.advance(40_000);
  assert.equal(runs(), 0);
  await clock.advance(20_000);
  assert.equal(runs(), 1);
});

test("dirty でフォーカスを失ったらすぐ書き出す", async () => {
  const { clock, s, runs } = setup();
  s.markDirty();
  s.noteFocusLost();
  await clock.advance(0);
  assert.equal(runs(), 1);
  assert.equal(s.isDirty(), false);
  assert.equal(clock.pending(), 0, "書き出し後はタイマーを残さない");
});

test("clean のときはフォーカス喪失でも書き出さない", async () => {
  const { clock, s, runs } = setup();
  s.noteFocusLost();
  await clock.advance(0);
  assert.equal(runs(), 0);
});

test("操作が続いても最初の変更から 10 分で書き出す", async () => {
  const { clock, s, runs } = setup();
  s.markDirty();
  for (let elapsed = 0; elapsed < MAX_WAIT_MS - 10_000; elapsed += 10_000) {
    await clock.advance(10_000);
    s.noteInput();
  }
  assert.equal(runs(), 0);
  await clock.advance(10_000);
  assert.equal(runs(), 1);
});

test("clean のときは操作があってもタイマーを張らず書き出さない", async () => {
  const { clock, s, runs } = setup();
  for (let i = 0; i < 5; i++) s.noteInput();
  assert.equal(clock.pending(), 0);
  await clock.advance(MAX_WAIT_MS * 2);
  assert.equal(runs(), 0);
});

test("失敗したら dirty に戻り、アイドルタイマーで再試行する", async () => {
  let fail = true;
  const { clock, s, runs } = setup(async () => {
    if (fail) throw new Error("boom");
  });
  s.markDirty();
  await clock.advance(IDLE_MS);
  assert.equal(runs(), 1);
  assert.equal(s.isDirty(), true);
  fail = false;
  await clock.advance(IDLE_MS - 1);
  assert.equal(runs(), 1, "すぐには再試行しない");
  await clock.advance(1);
  assert.equal(runs(), 2);
  assert.equal(s.isDirty(), false);
});

test("書き出し中の変更は、終わったあとアイドルタイマーで書き出す (即時ではない)", async () => {
  let release: () => void = () => {};
  let block = true;
  const { clock, s, runs } = setup(
    () =>
      new Promise<void>((resolve) => {
        if (!block) return resolve();
        release = resolve;
      }),
  );
  s.markDirty();
  s.noteFocusLost();
  await clock.advance(0);
  assert.equal(runs(), 1);
  assert.equal(s.isInFlight(), true);
  s.markDirty();
  s.noteFocusLost(); // 書き出し中は二重に走らせない
  await clock.advance(0);
  assert.equal(runs(), 1);
  block = false;
  release();
  await clock.advance(0);
  assert.equal(s.isInFlight(), false);
  assert.equal(s.isDirty(), true);
  assert.equal(runs(), 1, "終わった直後には走らない");
  await clock.advance(IDLE_MS);
  assert.equal(runs(), 2);
});

test("canRun が false (自動保存オフ) なら書き出さず dirty のまま", async () => {
  const clock = fakeClock();
  let runs = 0;
  const s = createAutoExportScheduler({
    run: async () => {
      runs++;
    },
    canRun: () => false,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  s.markDirty();
  s.noteFocusLost();
  await clock.advance(MAX_WAIT_MS);
  assert.equal(runs, 0);
  assert.equal(s.isDirty(), true);
});

test("markClean (終了時の書き出し済み) でタイマーを止める", async () => {
  const { clock, s, runs } = setup();
  s.markDirty();
  s.markClean();
  assert.equal(clock.pending(), 0);
  await clock.advance(MAX_WAIT_MS);
  assert.equal(runs(), 0);
});
