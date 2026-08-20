// DJ 純粋計算（クロスフェーダー / テンポ / SYNC）のテスト。

import {
  DEFAULT_TEMPO_RANGE,
  TEMPO_RANGES,
  crossfaderGains,
  effectiveBpm,
  formatTempoPercent,
  midiValueTo01,
  nextTempoRange,
  otherDeck,
  rateToTempo,
  syncTempo,
  tempoToRate,
} from "../math";

describe("crossfaderGains", () => {
  it("端では片側のみが鳴る", () => {
    expect(crossfaderGains(0)).toEqual({ a: 1, b: 0 });
    const right = crossfaderGains(1);
    expect(right.a).toBeCloseTo(0, 10);
    expect(right.b).toBeCloseTo(1, 10);
  });

  it("中央では両デッキ約 -3dB（等パワー）", () => {
    const { a, b } = crossfaderGains(0.5);
    expect(a).toBeCloseTo(Math.SQRT1_2, 5);
    expect(b).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it("範囲外は clamp される", () => {
    expect(crossfaderGains(-1)).toEqual(crossfaderGains(0));
    expect(crossfaderGains(2)).toEqual(crossfaderGains(1));
  });

  it("B 側ゲインは単調増加・A 側は単調減少", () => {
    let prev = crossfaderGains(0);
    for (let x = 0.1; x <= 1; x += 0.1) {
      const g = crossfaderGains(x);
      expect(g.b).toBeGreaterThan(prev.b);
      expect(g.a).toBeLessThan(prev.a);
      prev = g;
    }
  });
});

describe("tempoToRate / rateToTempo", () => {
  it("中央は等速、端はレンジ分だけ変わる", () => {
    expect(tempoToRate(0, 0.08)).toBe(1);
    expect(tempoToRate(1, 0.08)).toBeCloseTo(1.08);
    expect(tempoToRate(-1, 0.08)).toBeCloseTo(0.92);
  });

  it("範囲外テンポは ±1 に clamp", () => {
    expect(tempoToRate(5, 0.08)).toBeCloseTo(1.08);
    expect(tempoToRate(-5, 0.08)).toBeCloseTo(0.92);
  });

  it("rateToTempo は逆変換（レンジ内）", () => {
    expect(rateToTempo(1.04, 0.08)).toBeCloseTo(0.5);
    expect(rateToTempo(0.96, 0.08)).toBeCloseTo(-0.5);
    // レンジ外は clamp
    expect(rateToTempo(1.2, 0.08)).toBe(1);
    expect(rateToTempo(0.5, 0.08)).toBe(-1);
    // レンジ 0 はゼロ除算せず 0
    expect(rateToTempo(1.1, 0)).toBe(0);
  });
});

describe("effectiveBpm", () => {
  it("BPM × レート。BPM 不明は null", () => {
    expect(effectiveBpm(120, 1.05)).toBeCloseTo(126);
    expect(effectiveBpm(null, 1.05)).toBeNull();
    expect(effectiveBpm(0, 1.05)).toBeNull();
  });
});

describe("syncTempo", () => {
  it("相手の実効 BPM に合うテンポ位置を返す", () => {
    // 自分 120 BPM / 相手 126 BPM（等速）→ 必要レート 1.05 → ±8% 中の 0.625。
    expect(syncTempo(120, 126, 0, 0.08)).toBeCloseTo(0.625);
  });

  it("相手のテンポも考慮する", () => {
    // 相手 120 BPM が +8%（=129.6）で回っている → 必要レート 1.08 → 端 1.0。
    expect(syncTempo(120, 120, 1, 0.08)).toBeCloseTo(1);
  });

  it("レンジ外は ±1 に clamp（近づけるだけ）", () => {
    expect(syncTempo(100, 140, 0, 0.08)).toBe(1);
    expect(syncTempo(140, 100, 0, 0.08)).toBe(-1);
  });

  it("BPM 不明は null", () => {
    expect(syncTempo(null, 126, 0, 0.08)).toBeNull();
    expect(syncTempo(120, null, 0, 0.08)).toBeNull();
    expect(syncTempo(0, 126, 0, 0.08)).toBeNull();
  });
});

describe("nextTempoRange", () => {
  it("4 → 8 → 16 → 4 と循環する", () => {
    expect(nextTempoRange(TEMPO_RANGES[0])).toBe(TEMPO_RANGES[1]);
    expect(nextTempoRange(TEMPO_RANGES[1])).toBe(TEMPO_RANGES[2]);
    expect(nextTempoRange(TEMPO_RANGES[2])).toBe(TEMPO_RANGES[0]);
  });

  it("未知の値は既定へ戻す", () => {
    expect(nextTempoRange(0.5)).toBe(DEFAULT_TEMPO_RANGE);
  });
});

describe("表示/正規化ヘルパ", () => {
  it("formatTempoPercent", () => {
    expect(formatTempoPercent(0, 0.08)).toBe("0.0%");
    expect(formatTempoPercent(0.5, 0.08)).toBe("+4.0%");
    expect(formatTempoPercent(-1, 0.08)).toBe("-8.0%");
  });

  it("midiValueTo01", () => {
    expect(midiValueTo01(0)).toBe(0);
    expect(midiValueTo01(127)).toBe(1);
    expect(midiValueTo01(200)).toBe(1);
  });

  it("otherDeck", () => {
    expect(otherDeck("a")).toBe("b");
    expect(otherDeck("b")).toBe("a");
  });
});
