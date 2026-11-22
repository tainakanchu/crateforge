import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  IDLE_MS,
  MAX_WAIT_MS,
  createAutoExportScheduler,
} from "../../src/lib/autoExportScheduler.ts";

afterEach(() => {
  vi.useRealTimers();
});

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
  assert.equal(clock.pending(), 0, "書き出し中はタイマーを張らない (終わってから張る)");
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
  assert.equal(s.isDirty(), false);
  assert.equal(clock.pending(), 0);
  await clock.advance(MAX_WAIT_MS);
  assert.equal(runs(), 0);
});

test("変更が続いても上限のタイマーは 1 つだけで、markClean ですべて止まる", async () => {
  const { clock, s } = setup();
  s.markDirty();
  await clock.advance(1_000);
  s.markDirty();
  await clock.advance(1_000);
  s.markDirty();
  s.markClean();
  assert.equal(clock.pending(), 0);
});

test("上限は最初の変更の時刻から数える (起動直後でなくても)", async () => {
  const { clock, s, runs } = setup();
  await clock.advance(5_000);
  s.markDirty();
  for (let elapsed = 0; elapsed < MAX_WAIT_MS - 10_000; elapsed += 10_000) {
    await clock.advance(10_000);
    s.noteInput();
  }
  await clock.advance(9_999);
  assert.equal(runs(), 0);
  await clock.advance(1);
  assert.equal(runs(), 1);
});

/** 書き出しを途中で止めておき、テストから成功 / 失敗させる。 */
function blockingSetup() {
  let finish: (err?: Error) => void = () => {};
  const startedAt: number[] = [];
  const r = setup(() => {
    startedAt.push(r.clock.now());
    return new Promise<void>((resolve, reject) => {
      finish = (err) => (err ? reject(err) : resolve());
    });
  });
  return { ...r, startedAt, finish: (err?: Error) => finish(err) };
}

for (const outcome of ["成功", "失敗"] as const) {
  test(`書き出し中の変更の上限は、書き出しの終了 (${outcome}) ではなくその変更の時刻から数える`, async () => {
    const { clock, s, runs, finish, startedAt } = blockingSetup();
    s.markDirty();
    s.noteFocusLost(); // t=0 で書き出し開始
    await clock.advance(1_000);
    s.markDirty(); // t=1000 書き出し中の変更
    for (let i = 0; i < 9; i++) {
      await clock.advance(11_000);
      s.noteInput(); // 書き出し中も操作が続く
    }
    finish(outcome === "失敗" ? new Error("boom") : undefined); // t=100000 で終わる
    await clock.advance(0);
    assert.equal(runs(), 1);
    // 操作が続いてアイドルにならない。上限は t=1000 + MAX_WAIT_MS。
    while (runs() === 1 && clock.now() < 2 * MAX_WAIT_MS) {
      await clock.advance(10_000);
      s.noteInput();
    }
    assert.deepEqual(startedAt, [0, 1_000 + MAX_WAIT_MS]);
  });
}

test("clean のときの flush は書き出さない", async () => {
  const { s, runs } = setup();
  await s.flush();
  assert.equal(runs(), 0);
});

test("dispose 後は変更も書き出しも受け付けず、タイマーを残さない", async () => {
  const { clock, s, runs } = setup();
  s.markDirty();
  s.dispose();
  assert.equal(clock.pending(), 0);
  s.markDirty();
  assert.equal(s.isDirty(), true, "dispose 前の変更は残る");
  assert.equal(clock.pending(), 0);
  await s.flush();
  s.noteFocusLost();
  await clock.advance(MAX_WAIT_MS * 2);
  assert.equal(runs(), 0);

  const b = setup();
  b.s.dispose();
  b.s.markDirty();
  assert.equal(b.s.isDirty(), false, "dispose 後の変更は記録しない");
});

test("時計とタイマーを注入しなければ実時間で動く", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
  let runs = 0;
  const s = createAutoExportScheduler({
    run: async () => {
      runs++;
    },
  });
  s.markDirty();
  await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
  assert.equal(runs, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(runs, 1);
  s.markDirty();
  s.markClean();
  await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
  assert.equal(runs, 1, "markClean で実タイマーも止まる");
});
