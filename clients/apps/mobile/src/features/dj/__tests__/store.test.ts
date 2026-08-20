// DJ ストアのテスト。モックエンジンで load/play/cue/フェーダー/SYNC/ナッジの
// ロジックとエンジン呼び出しを検証する（ネイティブ非依存）。

import type { Track } from "@crateforge/core";

import { NUDGE_UP } from "../math";
import {
  resetDj,
  useDj,
  type DjEngine,
  type DjEngineHandlers,
} from "../store";
import type { DeckId } from "../math";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 42,
    persistentId: null,
    name: "Test Song",
    artist: "Test Artist",
    albumArtist: null,
    composer: null,
    album: "Test Album",
    genre: null,
    year: null,
    rating: null,
    playCount: null,
    skipCount: null,
    totalTimeMs: 240000,
    dateAdded: null,
    dateModified: null,
    bpm: 120,
    comments: null,
    locationRaw: null,
    locationPath: null,
    trackType: null,
    disabled: false,
    compilation: false,
    discNumber: null,
    discCount: null,
    trackNumber: null,
    trackCount: null,
    fileExists: true,
    lastPlayed: null,
    ...overrides,
  };
}

/** 呼び出しを記録するモックエンジン。 */
class MockEngine implements DjEngine {
  calls: string[] = [];
  handlers: DjEngineHandlers = {};
  gains: Record<DeckId, number> = { a: -1, b: -1 };
  rates: Record<DeckId, number> = { a: -1, b: -1 };

  load(deck: DeckId, track: { trackId: number }): void {
    this.calls.push(`load:${deck}:${track.trackId}`);
  }
  play(deck: DeckId): void {
    this.calls.push(`play:${deck}`);
  }
  pause(deck: DeckId): void {
    this.calls.push(`pause:${deck}`);
  }
  seekTo(deck: DeckId, seconds: number): void {
    this.calls.push(`seek:${deck}:${seconds}`);
  }
  setGain(deck: DeckId, gain: number): void {
    this.gains[deck] = gain;
  }
  setRate(deck: DeckId, rate: number): void {
    this.rates[deck] = rate;
  }
  setHandlers(handlers: DjEngineHandlers): void {
    this.handlers = handlers;
  }
  release(): void {
    this.calls.push("release");
  }
}

function setup(): MockEngine {
  resetDj();
  const engine = new MockEngine();
  useDj.getState().setEngine(engine);
  return engine;
}

describe("useDj: setEngine", () => {
  it("初期状態でゲイン（等パワー中央）とレート（等速）を適用する", () => {
    const engine = setup();
    expect(engine.gains.a).toBeCloseTo(Math.SQRT1_2, 5);
    expect(engine.gains.b).toBeCloseTo(Math.SQRT1_2, 5);
    expect(engine.rates.a).toBe(1);
    expect(engine.rates.b).toBe(1);
  });

  it("状態に残っているトラックを再ロードする（再入時の復元）", () => {
    setup();
    useDj.getState().loadTrack("a", makeTrack({ trackId: 7 }));
    // 画面を離れて再入 = shutdown → 新エンジン。
    useDj.getState().shutdown();
    const engine2 = new MockEngine();
    useDj.getState().setEngine(engine2);
    expect(engine2.calls).toContain("load:a:7");
    expect(useDj.getState().decks.a.isPlaying).toBe(false);
    expect(useDj.getState().decks.a.positionMs).toBe(0);
  });
});

describe("useDj: ロードと再生", () => {
  it("loadTrack はエンジンへロードし停止状態から始める", () => {
    const engine = setup();
    const track = makeTrack({ trackId: 7, totalTimeMs: 180000 });
    useDj.getState().loadTrack("a", track);
    expect(engine.calls).toContain("load:a:7");
    const d = useDj.getState().decks.a;
    expect(d.isPlaying).toBe(false);
    expect(d.positionMs).toBe(0);
    expect(d.durationMs).toBe(180000);
    expect(d.cueMs).toBe(0);
  });

  it("togglePlay: 未ロードでは何もしない / ロード後は play→pause をトグル", () => {
    const engine = setup();
    useDj.getState().togglePlay("a");
    expect(engine.calls).not.toContain("play:a");

    useDj.getState().loadTrack("a", makeTrack());
    useDj.getState().togglePlay("a");
    expect(engine.calls).toContain("play:a");
    expect(useDj.getState().decks.a.isPlaying).toBe(true);
    useDj.getState().togglePlay("a");
    expect(engine.calls).toContain("pause:a");
    expect(useDj.getState().decks.a.isPlaying).toBe(false);
  });

  it("デッキは独立に動く", () => {
    const engine = setup();
    useDj.getState().loadTrack("a", makeTrack({ trackId: 1 }));
    useDj.getState().loadTrack("b", makeTrack({ trackId: 2 }));
    useDj.getState().togglePlay("a");
    expect(useDj.getState().decks.a.isPlaying).toBe(true);
    expect(useDj.getState().decks.b.isPlaying).toBe(false);
    expect(engine.calls).toContain("load:b:2");
  });
});

describe("useDj: CUE", () => {
  it("停止中に押すと現在位置をキューポイントに設定する", () => {
    setup();
    useDj.getState().loadTrack("a", makeTrack());
    useDj.getState()._onProgress("a", 32000, 240000);
    useDj.getState().pressCue("a");
    expect(useDj.getState().decks.a.cueMs).toBe(32000);
  });

  it("再生中に押すとキューポイントへ戻って停止する", () => {
    const engine = setup();
    useDj.getState().loadTrack("a", makeTrack());
    useDj.getState()._onProgress("a", 32000, 240000);
    useDj.getState().pressCue("a"); // cue = 32s
    useDj.getState().togglePlay("a");
    useDj.getState()._onProgress("a", 64000, 240000);
    useDj.getState().pressCue("a");
    const d = useDj.getState().decks.a;
    expect(d.isPlaying).toBe(false);
    expect(d.positionMs).toBe(32000);
    expect(engine.calls).toContain("seek:a:32");
  });
});

describe("useDj: ミキサー", () => {
  it("クロスフェーダーとチャンネルフェーダーの積が最終ゲインになる", () => {
    const engine = setup();
    useDj.getState().setCrossfader(0); // A 側全開
    expect(engine.gains.a).toBeCloseTo(1);
    expect(engine.gains.b).toBeCloseTo(0);

    useDj.getState().setVolume("a", 0.5);
    expect(engine.gains.a).toBeCloseTo(0.5);

    useDj.getState().setCrossfader(1); // B 側全開
    expect(engine.gains.a).toBeCloseTo(0, 5);
    expect(engine.gains.b).toBeCloseTo(1);
  });

  it("範囲外は clamp される", () => {
    setup();
    useDj.getState().setCrossfader(2);
    expect(useDj.getState().crossfader).toBe(1);
    useDj.getState().setVolume("a", -1);
    expect(useDj.getState().decks.a.volume).toBe(0);
  });
});

describe("useDj: テンポ / SYNC / ナッジ", () => {
  it("setTempo でレートが変わる（±8% 既定）", () => {
    const engine = setup();
    useDj.getState().setTempo("a", 1);
    expect(engine.rates.a).toBeCloseTo(1.08);
    useDj.getState().setTempo("a", -0.5);
    expect(engine.rates.a).toBeCloseTo(0.96);
  });

  it("cycleTempoRange 後もレートが再適用される", () => {
    const engine = setup();
    useDj.getState().setTempo("a", 1);
    useDj.getState().cycleTempoRange(); // 0.08 → 0.16
    expect(useDj.getState().tempoRange).toBeCloseTo(0.16);
    expect(engine.rates.a).toBeCloseTo(1.16);
  });

  it("SYNC は相手デッキの実効 BPM に合わせる", () => {
    const engine = setup();
    useDj.getState().loadTrack("a", makeTrack({ trackId: 1, bpm: 120 }));
    useDj.getState().loadTrack("b", makeTrack({ trackId: 2, bpm: 126 }));
    expect(useDj.getState().sync("a")).toBe(true);
    // 必要レート 1.05 → tempo 0.625（±8%）。
    expect(useDj.getState().decks.a.tempo).toBeCloseTo(0.625);
    expect(engine.rates.a).toBeCloseTo(1.05);
  });

  it("BPM が無ければ SYNC は失敗して何も変えない", () => {
    setup();
    useDj.getState().loadTrack("a", makeTrack({ trackId: 1, bpm: null }));
    useDj.getState().loadTrack("b", makeTrack({ trackId: 2, bpm: 126 }));
    expect(useDj.getState().sync("a")).toBe(false);
    expect(useDj.getState().decks.a.tempo).toBe(0);
  });

  it("ナッジはホールド中のみレートに乗り、解除で戻る", () => {
    const engine = setup();
    useDj.getState().setTempo("a", 0.5); // rate 1.04
    useDj.getState().setNudge("a", NUDGE_UP);
    expect(engine.rates.a).toBeCloseTo(1.04 * NUDGE_UP);
    useDj.getState().setNudge("a", null);
    expect(engine.rates.a).toBeCloseTo(1.04);
  });
});

describe("useDj: エンジンイベント", () => {
  it("進捗で position/duration が更新される（duration 0 はメタ値を維持）", () => {
    setup();
    useDj.getState().loadTrack("a", makeTrack({ totalTimeMs: 240000 }));
    useDj.getState()._onProgress("a", 1000, 0);
    expect(useDj.getState().decks.a.positionMs).toBe(1000);
    expect(useDj.getState().decks.a.durationMs).toBe(240000);
    useDj.getState()._onProgress("a", 2000, 239500);
    expect(useDj.getState().decks.a.durationMs).toBe(239500);
  });

  it("曲終了で停止する（自動で次には進まない）", () => {
    setup();
    useDj.getState().loadTrack("a", makeTrack());
    useDj.getState().togglePlay("a");
    useDj.getState()._onFinished("a");
    expect(useDj.getState().decks.a.isPlaying).toBe(false);
  });

  it("エラーで lastError が立ち、デッキは停止扱いになる", () => {
    setup();
    useDj.getState().loadTrack("a", makeTrack());
    useDj.getState().togglePlay("a");
    useDj.getState()._onError("a", "boom");
    const s = useDj.getState();
    expect(s.decks.a.isPlaying).toBe(false);
    expect(s.lastError?.deck).toBe("a");
    expect(s.lastError?.message).toBe("boom");
    s.clearError();
    expect(useDj.getState().lastError).toBeNull();
  });
});

describe("useDj: shutdown", () => {
  it("両デッキ停止・エンジン解放・Noop へ戻す", () => {
    const engine = setup();
    useDj.getState().loadTrack("a", makeTrack());
    useDj.getState().togglePlay("a");
    useDj.getState().shutdown();
    expect(engine.calls).toContain("pause:a");
    expect(engine.calls).toContain("pause:b");
    expect(engine.calls).toContain("release");
    const s = useDj.getState();
    expect(s.decks.a.isPlaying).toBe(false);
    // トラック自体は保持される（再入時に復元するため）。
    expect(s.decks.a.track?.trackId).toBe(42);
  });
});
