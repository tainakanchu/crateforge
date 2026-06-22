import { type Track, type AudioEngine, type EngineHandlers, resetPlayer, usePlayer } from "@crateforge/core";

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
  engine = new FakeEngine();
  usePlayer.getState().setEngine(engine);
});

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

describe("shuffle", () => {
  it("picks a different index on next", () => {
    const spy = jest.spyOn(Math, "random").mockReturnValue(0); // -> index 0; same as current -> +1
    s().setQueue([track(1), track(2), track(3)]); // index 0
    s().setShuffle(true);
    s().next();
    expect(s().current()?.id).toBe(2); // 0 collided -> bumped to 1
    spy.mockRestore();
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
