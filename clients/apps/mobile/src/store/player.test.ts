import * as SecureStore from "expo-secure-store";

import { type Track, type AudioEngine, type EngineHandlers, resetPlayer, upNextEntries, usePlayer } from "@crateforge/core";

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

class FakeEngine implements AudioEngine {
  loaded: Track[] = [];
  handlers: EngineHandlers = {};
  playCount = 0;
  pauseCount = 0;
  seeked: number[] = [];
  load(t: Track) {
    this.loaded.push(t);
  }
  play() {
    this.playCount++;
  }
  pause() {
    this.pauseCount++;
  }
  seekTo(s: number) {
    this.seeked.push(s);
  }
  setVolume() {}
  setRate(_rate: number) {}
  setHandlers(h: EngineHandlers) {
    this.handlers = h;
  }
  release() {}
}

function track(id: number): Track {
  return { id, trackId: id, name: `T${id}` } as Track;
}

let engine: FakeEngine;

beforeEach(() => {
  resetPlayer();
  getItem.mockReset().mockResolvedValue(null);
  setItem.mockReset().mockResolvedValue(undefined);
  engine = new FakeEngine();
  usePlayer.getState().setEngine(engine);
});

/** order が 0..n-1 の順列で、order[orderPos] === index であることを検証する。 */
function expectPermutationInvariant(): void {
  const { queue, order, orderPos, index } = s();
  expect([...order].sort((a, b) => a - b)).toEqual(
    Array.from({ length: queue.length }, (_, i) => i),
  );
  if (queue.length === 0) {
    expect(orderPos).toBe(-1);
    expect(index).toBe(-1);
    return;
  }
  expect(orderPos).toBeGreaterThanOrEqual(0);
  expect(orderPos).toBeLessThan(order.length);
  expect(order[orderPos]).toBe(index);
}

const s = () => usePlayer.getState();

describe("setQueue / playAt", () => {
  it("plays from index 0 by default", () => {
    s().setQueue([track(1), track(2), track(3)]);
    expect(s().current()?.id).toBe(1);
    expect(s().isPlaying).toBe(true);
    expect(engine.loaded.map((t) => t.id)).toEqual([1]);
    expect(engine.playCount).toBe(1);
  });
  it("honors startIndex and clamps", () => {
    s().setQueue([track(1), track(2), track(3)], 2);
    expect(s().current()?.id).toBe(3);
    s().setQueue([track(1), track(2)], 99);
    expect(s().current()?.id).toBe(2);
  });
  it("empty queue resets to idle", () => {
    s().setQueue([]);
    expect(s().index).toBe(-1);
    expect(s().current()).toBeNull();
    expect(s().isPlaying).toBe(false);
  });
});

describe("next / prev", () => {
  beforeEach(() => s().setQueue([track(1), track(2), track(3)]));

  it("advances to next", () => {
    s().next();
    expect(s().current()?.id).toBe(2);
  });
  it("stops at end when repeat off", () => {
    s().setQueue([track(1), track(2), track(3)], 2);
    s().next();
    expect(s().isPlaying).toBe(false);
    expect(s().current()?.id).toBe(3); // index unchanged at end
  });
  it("wraps when repeat all", () => {
    s().setRepeat("all");
    s().setQueue([track(1), track(2)], 1);
    s().next();
    expect(s().current()?.id).toBe(1);
  });
  it("repeat one replays same track on auto-finish", () => {
    s().setRepeat("one");
    s().next(true);
    expect(s().current()?.id).toBe(1);
    expect(engine.loaded.map((t) => t.id)).toEqual([1, 1]);
  });
  it("manual next ignores repeat one", () => {
    s().setRepeat("one");
    s().next(false);
    expect(s().current()?.id).toBe(2);
  });
  it("prev seeks to 0 when past 3s", () => {
    s().next(); // now at index 1
    s()._onProgress(5000, 200000);
    s().prev();
    expect(s().current()?.id).toBe(2);
    expect(engine.seeked).toContain(0);
  });
  it("prev goes back when near start", () => {
    s().next(); // index 1, position 0
    s().prev();
    expect(s().current()?.id).toBe(1);
  });
});

describe("enqueue", () => {
  it("enqueue to empty starts playback", () => {
    s().enqueue(track(5));
    expect(s().current()?.id).toBe(5);
    expect(s().isPlaying).toBe(true);
  });
  it("enqueueNext inserts after current", () => {
    s().setQueue([track(1), track(2)]); // index 0
    s().enqueueNext(track(9));
    expect(s().queue.map((t) => t.id)).toEqual([1, 9, 2]);
  });
});

describe("engine events", () => {
  it("onProgress updates position/duration", () => {
    s().setQueue([track(1)]);
    engine.handlers.onProgress?.(1500, 240000);
    expect(s().positionMs).toBe(1500);
    expect(s().durationMs).toBe(240000);
  });
  it("onFinished advances to next track", () => {
    s().setQueue([track(1), track(2)]);
    engine.handlers.onFinished?.();
    expect(s().current()?.id).toBe(2);
  });
});

describe("error handling (#67)", () => {
  // console.warn を黙らせつつ呼び出しは検証可能にする。
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it("onError sets lastError, logs, and auto-skips to the next track", () => {
    s().setQueue([track(1), track(2)]); // index 0
    engine.handlers.onError?.("boom");
    expect(warnSpy).toHaveBeenCalled();
    expect(s().lastError?.message).toBe("boom");
    expect(s().current()?.id).toBe(2); // skipped to next
  });

  it("clearError clears the notification state", () => {
    s().setQueue([track(1), track(2)]);
    engine.handlers.onError?.("boom");
    expect(s().lastError).not.toBeNull();
    s().clearError();
    expect(s().lastError).toBeNull();
  });

  it("stops after MAX_CONSECUTIVE_FAILURES consecutive failures (no infinite skip)", () => {
    s().setQueue([track(1), track(2), track(3), track(4), track(5)]);
    // 3回連続失敗で停止する想定（しきい値 3）。
    engine.handlers.onError?.("e1"); // index 0 -> skip to 1
    engine.handlers.onError?.("e2"); // index 1 -> skip to 2
    engine.handlers.onError?.("e3"); // 3回目 -> 停止
    expect(s().isPlaying).toBe(false);
    expect(s().lastError?.message).toBe("再生できない曲が続いたため停止しました");
  });

  it("resets the failure counter once playback actually progresses", () => {
    s().setQueue([track(1), track(2), track(3), track(4), track(5)]);
    engine.handlers.onError?.("e1"); // skip to 1
    engine.handlers.onError?.("e2"); // skip to 2
    // 実際に再生が進んだ → カウンタリセット。
    s()._onProgress(1000, 200000);
    // さらに2回失敗しても、リセット後なので即停止はしない（次へ進める）。
    engine.handlers.onError?.("e3"); // skip to 3
    engine.handlers.onError?.("e4"); // skip to 4
    expect(s().isPlaying).toBe(true);
    expect(s().current()?.id).toBe(5);
  });

  it("stops (no skip) when the failing track is the last with repeat off", () => {
    s().setQueue([track(1), track(2)], 1); // index 1 (last)
    engine.handlers.onError?.("boom");
    expect(s().isPlaying).toBe(false);
    expect(s().current()?.id).toBe(2); // index unchanged at the end
  });

  it("setQueue clears a prior error and failure state", () => {
    s().setQueue([track(1)], 0);
    engine.handlers.onError?.("boom");
    expect(s().lastError).not.toBeNull();
    s().setQueue([track(9), track(10)]);
    expect(s().lastError).toBeNull();
  });
});

describe("shuffle (順列モデル #158)", () => {
  /** Math.random を 0 に固定すると Fisher-Yates は決定的になる。 */
  function fixedRandom(): jest.SpyInstance {
    return jest.spyOn(Math, "random").mockReturnValue(0);
  }

  it("setShuffle(true) は現在位置より後ろだけを混ぜ、決定的な順列を作る", () => {
    const spy = fixedRandom();
    s().setQueue([track(1), track(2), track(3), track(4)]); // index 0
    expect(s().order).toEqual([0, 1, 2, 3]);
    s().setShuffle(true);
    // 先頭（再生中）は動かず、残り [1,2,3] が Fisher-Yates(random=0) で [2,3,1] に。
    expect(s().order).toEqual([0, 2, 3, 1]);
    expect(s().index).toBe(0);
    expect(s().current()?.id).toBe(1);
    expect(s().upNext().map((t) => t.id)).toEqual([3, 4, 2]);
    expectPermutationInvariant();

    s().next();
    expect(s().current()?.id).toBe(3);
    s().next();
    expect(s().current()?.id).toBe(4);
    s().next();
    expect(s().current()?.id).toBe(2);
    expectPermutationInvariant();
    spy.mockRestore();
  });

  it("setShuffle(false) は自然順へ戻し、再生中の曲を現在位置に保つ", () => {
    const spy = fixedRandom();
    s().setQueue([track(1), track(2), track(3), track(4)]);
    s().setShuffle(true);
    s().next(); // order [0,2,3,1] -> track 3 (queue index 2)
    expect(s().current()?.id).toBe(3);
    s().setShuffle(false);
    expect(s().order).toEqual([0, 1, 2, 3]);
    expect(s().orderPos).toBe(2);
    expect(s().current()?.id).toBe(3); // 同じ曲のまま
    expect(s().upNext().map((t) => t.id)).toEqual([4]);
    expectPermutationInvariant();
    spy.mockRestore();
  });

  it("一巡の中で同じ曲が二度出ない（全曲をちょうど 1 回ずつ再生する）", () => {
    const tracks = [track(1), track(2), track(3), track(4), track(5)];
    s().setQueue(tracks);
    s().setShuffle(true);
    const seen = [s().current()!.id];
    for (let i = 0; i < tracks.length - 1; i++) {
      s().next();
      seen.push(s().current()!.id);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seen).size).toBe(5);
  });

  it("末尾 + repeat all は次の一巡を再シャッフルし、直前の曲を先頭に置かない", () => {
    s().setQueue([track(1), track(2), track(3), track(4)]);
    s().setShuffle(true);
    s().setRepeat("all");
    for (let i = 0; i < 3; i++) s().next(); // 末尾まで進む
    const last = s().current()!.id;
    s().next(); // 新しい一巡へ
    expect(s().current()?.id).not.toBe(last);
    expect(s().orderPos).toBe(0);
    expectPermutationInvariant();
  });

  it("next の直後の prev は同じ曲へ戻る（再生順を逆に辿る）", () => {
    s().setQueue([track(1), track(2), track(3), track(4), track(5)]);
    s().setShuffle(true);
    const first = s().current()!.id;
    s().next();
    const second = s().current()!.id;
    expect(second).not.toBe(first);
    s().prev();
    expect(s().current()?.id).toBe(first);
    s().next();
    expect(s().current()?.id).toBe(second); // 同じ順列を辿り直す
  });

  it("enqueueNext は shuffle 中でも再生順の「次」に入る", () => {
    const spy = fixedRandom();
    s().setQueue([track(1), track(2), track(3), track(4)]);
    s().setShuffle(true);
    s().enqueueNext(track(9));
    expect(s().current()?.id).toBe(1); // 再生中は変わらない
    expect(s().upNext().map((t) => t.id)).toEqual([9, 3, 4, 2]);
    expectPermutationInvariant();
    s().next();
    expect(s().current()?.id).toBe(9);
    spy.mockRestore();
  });

  it("removeQueueAt / moveQueueItem は順列の不変条件を保つ", () => {
    const spy = fixedRandom();
    s().setQueue([track(1), track(2), track(3), track(4), track(5)]);
    s().setShuffle(true);
    s().removeQueueAt(3);
    expectPermutationInvariant();
    expect(s().queue.map((t) => t.id)).toEqual([1, 2, 3, 5]);
    s().moveQueueItem(3, 1);
    expectPermutationInvariant();
    spy.mockRestore();
  });

  it("moveUpNext は Up Next 内だけ並べ替える（再生済み/再生中は動かせない）", () => {
    const spy = fixedRandom();
    s().setQueue([track(1), track(2), track(3), track(4)]);
    s().setShuffle(true); // order [0,2,3,1], orderPos 0
    expect(s().upNext().map((t) => t.id)).toEqual([3, 4, 2]);
    s().moveUpNext(3, 1); // 末尾の 2 を Up Next の先頭へ
    expect(s().upNext().map((t) => t.id)).toEqual([2, 3, 4]);
    expectPermutationInvariant();
    // 現在位置以前へは動かせない（no-op）。
    const before = [...s().order];
    s().moveUpNext(1, 0);
    expect(s().order).toEqual(before);
    spy.mockRestore();
  });

  it("upNextEntries は queue / order 上の位置を添えて返す", () => {
    const spy = fixedRandom();
    s().setQueue([track(1), track(2), track(3), track(4)]);
    s().setShuffle(true); // order [0,2,3,1]
    expect(upNextEntries(s())).toEqual([
      { track: s().queue[2], queueIndex: 2, orderIndex: 1 },
      { track: s().queue[3], queueIndex: 3, orderIndex: 2 },
      { track: s().queue[1], queueIndex: 1, orderIndex: 3 },
    ]);
    spy.mockRestore();
  });
});

describe("shuffle / repeat の永続化 (#158)", () => {
  it("setShuffle が SecureStore へ書き込む", () => {
    s().setShuffle(true);
    expect(setItem).toHaveBeenCalledWith("crateforge.player.shuffle", "true");
    s().setShuffle(false);
    expect(setItem).toHaveBeenCalledWith("crateforge.player.shuffle", "false");
  });

  it("setRepeat が SecureStore へ書き込む", () => {
    s().setRepeat("all");
    expect(setItem).toHaveBeenCalledWith("crateforge.player.repeat", "all");
  });

  it("hydrate が保存済みの shuffle / repeat を復元する", async () => {
    getItem.mockImplementation(async (key: string) =>
      key === "crateforge.player.shuffle" ? "true"
        : key === "crateforge.player.repeat" ? "one"
          : null,
    );
    await s().hydrate();
    expect(s().shuffle).toBe(true);
    expect(s().repeat).toBe("one");
  });

  it("hydrate は不正な値を無視して既定のままにする", async () => {
    getItem.mockImplementation(async () => "garbage");
    await s().hydrate();
    expect(s().shuffle).toBe(false);
    expect(s().repeat).toBe("off");
  });

  it("hydrate 後の shuffle は既存キューの順列へ反映される", async () => {
    const spy = jest.spyOn(Math, "random").mockReturnValue(0);
    s().setQueue([track(1), track(2), track(3), track(4)]);
    getItem.mockImplementation(async (key: string) =>
      key === "crateforge.player.shuffle" ? "true" : null,
    );
    await s().hydrate();
    expect(s().shuffle).toBe(true);
    expect(s().order).toEqual([0, 2, 3, 1]);
    expectPermutationInvariant();
    spy.mockRestore();
  });

  it("読み出し失敗でも既定値で動く", async () => {
    getItem.mockImplementation(async () => {
      throw new Error("boom");
    });
    await s().hydrate();
    expect(s().shuffle).toBe(false);
    expect(s().repeat).toBe("off");
  });
});

describe("toggle / pause / play", () => {
  it("toggles play state", () => {
    s().setQueue([track(1)]);
    expect(s().isPlaying).toBe(true);
    s().toggle();
    expect(s().isPlaying).toBe(false);
    expect(engine.pauseCount).toBe(1);
    s().toggle();
    expect(s().isPlaying).toBe(true);
  });
});

describe("removeQueueAt", () => {
  it("removes a track after current without changing index", () => {
    s().setQueue([track(1), track(2), track(3)]); // index 0 → track 1
    s().removeQueueAt(2); // remove track 3
    expect(s().queue.map((t) => t.id)).toEqual([1, 2]);
    expect(s().current()?.id).toBe(1); // still playing track 1
    expect(s().index).toBe(0);
  });

  it("removes a track before current and decrements index", () => {
    s().setQueue([track(1), track(2), track(3)], 2); // index 2 → track 3
    s().removeQueueAt(0); // remove track 1
    expect(s().queue.map((t) => t.id)).toEqual([2, 3]);
    expect(s().index).toBe(1); // still points at track 3
    expect(s().current()?.id).toBe(3);
  });

  it("removes the current track and plays the next one", () => {
    s().setQueue([track(1), track(2), track(3)]); // index 0 → track 1
    s().removeQueueAt(0); // remove currently playing track
    expect(s().queue.map((t) => t.id)).toEqual([2, 3]);
    // Should now be playing at index 0 (next track = track 2)
    expect(s().current()?.id).toBe(2);
    expect(s().isPlaying).toBe(true);
  });

  it("removes the last current track and plays the previous (now last)", () => {
    s().setQueue([track(1), track(2), track(3)], 2); // index 2 → track 3
    s().removeQueueAt(2); // remove currently playing last track
    expect(s().queue.map((t) => t.id)).toEqual([1, 2]);
    // Should now be at end → plays last remaining
    expect(s().current()?.id).toBe(2);
    expect(s().isPlaying).toBe(true);
  });

  it("clears queue when last remaining track is removed", () => {
    s().setQueue([track(1)]); // single track
    s().removeQueueAt(0);
    expect(s().queue).toHaveLength(0);
    expect(s().index).toBe(-1);
    expect(s().isPlaying).toBe(false);
  });

  it("is a no-op for out-of-bounds index", () => {
    s().setQueue([track(1), track(2)]);
    s().removeQueueAt(5);
    expect(s().queue).toHaveLength(2);
    s().removeQueueAt(-1);
    expect(s().queue).toHaveLength(2);
  });
});

describe("moveQueueItem", () => {
  it("moves a track forward and keeps index on same track", () => {
    s().setQueue([track(1), track(2), track(3), track(4)]); // index 0 → track 1
    s().moveQueueItem(3, 1); // move track 4 to position 1
    expect(s().queue.map((t) => t.id)).toEqual([1, 4, 2, 3]);
    expect(s().index).toBe(0); // track 1 still at 0
    expect(s().current()?.id).toBe(1);
  });

  it("moves a track backward and keeps index on same track", () => {
    s().setQueue([track(1), track(2), track(3), track(4)], 2); // index 2 → track 3
    s().moveQueueItem(0, 2); // move track 1 to position 2
    // [2, 3, 1, 4] — but 'from < index' and 'to >= index' so index goes from 2 to 1
    expect(s().queue.map((t) => t.id)).toEqual([2, 3, 1, 4]);
    expect(s().index).toBe(1); // adjusted: track 3 is now at 1
    expect(s().current()?.id).toBe(3);
  });

  it("moves the current track itself and index follows", () => {
    s().setQueue([track(1), track(2), track(3)], 1); // index 1 → track 2
    s().moveQueueItem(1, 2); // move current to end
    expect(s().queue.map((t) => t.id)).toEqual([1, 3, 2]);
    expect(s().index).toBe(2); // track 2 is now at index 2
    expect(s().current()?.id).toBe(2);
  });

  it("is a no-op for same from/to", () => {
    s().setQueue([track(1), track(2), track(3)]);
    s().moveQueueItem(1, 1);
    expect(s().queue.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("is a no-op for out-of-bounds indices", () => {
    s().setQueue([track(1), track(2)]);
    s().moveQueueItem(0, 5);
    expect(s().queue.map((t) => t.id)).toEqual([1, 2]);
    s().moveQueueItem(-1, 0);
    expect(s().queue.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe("setRate", () => {
  it("sets playback rate within valid range", () => {
    s().setQueue([track(1)]);
    s().setRate(1.5);
    expect(s().playbackRate).toBe(1.5);
  });

  it("clamps rate to minimum 0.5", () => {
    s().setRate(0.1);
    expect(s().playbackRate).toBe(0.5);
  });

  it("clamps rate to maximum 2.0", () => {
    s().setRate(5.0);
    expect(s().playbackRate).toBe(2.0);
  });

  it("calls engine.setRate with clamped value", () => {
    const rates: number[] = [];
    // FakeEngine already has setRate; spy on the current engine instance
    const rateSpy = jest.spyOn(engine, "setRate").mockImplementation((r) => {
      rates.push(r);
    });
    usePlayer.getState().setRate(1.25);
    expect(rates).toContain(1.25);
    usePlayer.getState().setRate(0.1);
    expect(rates).toContain(0.5); // clamped
    rateSpy.mockRestore();
  });

  it("initializes playbackRate to 1", () => {
    expect(s().playbackRate).toBe(1);
  });
});

describe("setSleepTimer", () => {
  it("stores sleep timer value", () => {
    s().setSleepTimer(15 * 60 * 1000);
    expect(s().sleepTimerMs).toBe(15 * 60 * 1000);
    expect(s().stopAtTrackEnd).toBe(false);
  });

  it("clears sleep timer with null", () => {
    s().setSleepTimer(15 * 60 * 1000);
    s().setSleepTimer(null);
    expect(s().sleepTimerMs).toBeNull();
  });

  it("setSleepTimer clears stopAtTrackEnd", () => {
    s().setStopAtTrackEnd(true);
    expect(s().stopAtTrackEnd).toBe(true);
    s().setSleepTimer(30 * 60 * 1000);
    expect(s().stopAtTrackEnd).toBe(false);
    expect(s().sleepTimerMs).toBe(30 * 60 * 1000);
  });

  it("setStopAtTrackEnd clears sleepTimerMs", () => {
    s().setSleepTimer(15 * 60 * 1000);
    expect(s().sleepTimerMs).toBe(15 * 60 * 1000);
    s().setStopAtTrackEnd(true);
    expect(s().stopAtTrackEnd).toBe(true);
    expect(s().sleepTimerMs).toBeNull();
  });

  it("initializes sleepTimerMs to null and stopAtTrackEnd to false", () => {
    expect(s().sleepTimerMs).toBeNull();
    expect(s().stopAtTrackEnd).toBe(false);
  });
});
