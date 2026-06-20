import type { Track } from "@/lib/types";
import {
  type AudioEngine,
  type EngineHandlers,
  resetPlayer,
  usePlayer,
} from "@/store/player";

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
