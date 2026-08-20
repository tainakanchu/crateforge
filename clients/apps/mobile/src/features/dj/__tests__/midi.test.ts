// MIDI マッピング層のテスト。バインディングキー導出 / メッセージ→操作の変換 /
// 永続化 JSON の検証 / ラーンフローを確認する（ネイティブモジュール非依存）。

import { NUDGE_DOWN, NUDGE_UP } from "../math";
import {
  ALL_MIDI_TARGETS,
  applyMidiMessage,
  bindingKeyOf,
  isContinuousTarget,
  isLearnableMessage,
  parseStoredMapping,
  resetDjMidi,
  targetLabel,
  useDjMidi,
  type DjMidiApi,
  type MidiMapping,
} from "../midi";
import { resetDj, useDj } from "../store";

/** 全操作を記録するモック API。 */
function makeApi(): DjMidiApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    togglePlay: (d) => calls.push(`togglePlay:${d}`),
    pressCue: (d) => calls.push(`pressCue:${d}`),
    sync: (d) => {
      calls.push(`sync:${d}`);
      return true;
    },
    setVolume: (d, v) => calls.push(`setVolume:${d}:${v.toFixed(3)}`),
    setTempo: (d, t) => calls.push(`setTempo:${d}:${t.toFixed(3)}`),
    setCrossfader: (x) => calls.push(`setCrossfader:${x.toFixed(3)}`),
    setNudge: (d, f) => calls.push(`setNudge:${d}:${f == null ? "null" : f}`),
  };
}

describe("bindingKeyOf", () => {
  it("CC / NoteOn / NoteOff を種別:ch:番号 に正規化する", () => {
    expect(bindingKeyOf({ status: 0xb0, data1: 17, data2: 64 })).toBe("cc:0:17");
    expect(bindingKeyOf({ status: 0xb3, data1: 17, data2: 64 })).toBe("cc:3:17");
    expect(bindingKeyOf({ status: 0x90, data1: 12, data2: 100 })).toBe("note:0:12");
    // NoteOff は同じ操作子の Note キーへ正規化される。
    expect(bindingKeyOf({ status: 0x80, data1: 12, data2: 0 })).toBe("note:0:12");
  });

  it("対象外メッセージ（ピッチベンド等）は null", () => {
    expect(bindingKeyOf({ status: 0xe0, data1: 0, data2: 64 })).toBeNull();
    expect(bindingKeyOf({ status: 0xc0, data1: 5, data2: 0 })).toBeNull();
  });
});

describe("applyMidiMessage", () => {
  const mapping: MidiMapping = {
    "xfader": "cc:0:11",
    "deck:a:volume": "cc:0:17",
    "deck:a:tempo": "cc:0:18",
    "deck:a:play": "note:0:1",
    "deck:b:cue": "cc:0:70",
    "deck:b:sync": "note:0:2",
    "deck:a:nudge+": "note:0:3",
  };

  it("未マッピングのメッセージは false", () => {
    const api = makeApi();
    expect(applyMidiMessage({ status: 0xb0, data1: 99, data2: 0 }, mapping, api)).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it("連続値: クロスフェーダー / ボリュームは 0..1、テンポは -1..1", () => {
    const api = makeApi();
    applyMidiMessage({ status: 0xb0, data1: 11, data2: 127 }, mapping, api);
    applyMidiMessage({ status: 0xb0, data1: 17, data2: 0 }, mapping, api);
    applyMidiMessage({ status: 0xb0, data1: 18, data2: 127 }, mapping, api);
    expect(api.calls).toEqual([
      "setCrossfader:1.000",
      "setVolume:a:0.000",
      "setTempo:a:1.000",
    ]);
  });

  it("ボタン: NoteOn 押下でのみ発火し、NoteOff では発火しない", () => {
    const api = makeApi();
    applyMidiMessage({ status: 0x90, data1: 1, data2: 100 }, mapping, api);
    applyMidiMessage({ status: 0x80, data1: 1, data2: 0 }, mapping, api);
    // velocity 0 の NoteOn も解放扱い。
    applyMidiMessage({ status: 0x90, data1: 1, data2: 0 }, mapping, api);
    expect(api.calls).toEqual(["togglePlay:a"]);
  });

  it("ボタン: CC は 64 以上で押下（DJM 系の 127/0 ボタンに対応）", () => {
    const api = makeApi();
    applyMidiMessage({ status: 0xb0, data1: 70, data2: 127 }, mapping, api);
    applyMidiMessage({ status: 0xb0, data1: 70, data2: 0 }, mapping, api);
    expect(api.calls).toEqual(["pressCue:b"]);
  });

  it("SYNC ボタンも押下エッジで発火", () => {
    const api = makeApi();
    applyMidiMessage({ status: 0x90, data1: 2, data2: 127 }, mapping, api);
    expect(api.calls).toEqual(["sync:b"]);
  });

  it("ナッジは押下でホールド開始・解放で解除", () => {
    const api = makeApi();
    applyMidiMessage({ status: 0x90, data1: 3, data2: 127 }, mapping, api);
    applyMidiMessage({ status: 0x80, data1: 3, data2: 0 }, mapping, api);
    expect(api.calls).toEqual([`setNudge:a:${NUDGE_UP}`, "setNudge:a:null"]);
    expect(NUDGE_DOWN).toBeLessThan(1);
  });
});

describe("parseStoredMapping", () => {
  it("正しい JSON はそのまま復元する", () => {
    const raw = JSON.stringify({ "xfader": "cc:0:11", "deck:a:play": "note:2:5" });
    expect(parseStoredMapping(raw)).toEqual({
      "xfader": "cc:0:11",
      "deck:a:play": "note:2:5",
    });
  });

  it("不正なターゲット/キーは捨てる", () => {
    const raw = JSON.stringify({
      "xfader": "cc:0:11",
      "deck:c:play": "cc:0:12", // 不明デッキ
      "deck:a:play": "pitchbend:0:1", // 不明メッセージ種別
      "deck:b:play": 5, // 型不正
      "deck:b:cue": "cc:99:1", // チャンネル範囲外
    });
    expect(parseStoredMapping(raw)).toEqual({ "xfader": "cc:0:11" });
  });

  it("null / 壊れた JSON / 非オブジェクトは空", () => {
    expect(parseStoredMapping(null)).toEqual({});
    expect(parseStoredMapping("not json")).toEqual({});
    expect(parseStoredMapping("[1,2]")).toEqual({});
  });
});

describe("useDjMidi (ラーンフロー)", () => {
  beforeEach(() => {
    resetDj();
    resetDjMidi();
  });

  it("ラーン待ち中の CC でバインドされ、待機が解除される", () => {
    const s = useDjMidi.getState();
    s.setLearnTarget("deck:a:volume");
    s.handleMessage({ status: 0xb2, data1: 17, data2: 42 });
    expect(useDjMidi.getState().mapping["deck:a:volume"]).toBe("cc:2:17");
    expect(useDjMidi.getState().learnTarget).toBeNull();
  });

  it("NoteOff ではラーンしない（押下で覚える）", () => {
    const s = useDjMidi.getState();
    s.setLearnTarget("deck:a:play");
    s.handleMessage({ status: 0x80, data1: 9, data2: 0 });
    expect(useDjMidi.getState().mapping["deck:a:play"]).toBeUndefined();
    expect(useDjMidi.getState().learnTarget).toBe("deck:a:play");
    s.handleMessage({ status: 0x90, data1: 9, data2: 100 });
    expect(useDjMidi.getState().mapping["deck:a:play"]).toBe("note:0:9");
  });

  it("通常時はメッセージが DJ ストアへディスパッチされる", () => {
    useDjMidi.setState({ mapping: { "xfader": "cc:0:11" } });
    useDjMidi.getState().handleMessage({ status: 0xb0, data1: 11, data2: 127 });
    expect(useDj.getState().crossfader).toBe(1);
  });

  it("clearBinding / clearAll", () => {
    useDjMidi.setState({ mapping: { "xfader": "cc:0:11", "deck:a:play": "note:0:1" } });
    useDjMidi.getState().clearBinding("xfader");
    expect(useDjMidi.getState().mapping).toEqual({ "deck:a:play": "note:0:1" });
    useDjMidi.getState().clearAll();
    expect(useDjMidi.getState().mapping).toEqual({});
  });
});

describe("ターゲット定義", () => {
  it("連続値ターゲットの判定", () => {
    expect(isContinuousTarget("xfader")).toBe(true);
    expect(isContinuousTarget("deck:a:volume")).toBe(true);
    expect(isContinuousTarget("deck:b:tempo")).toBe(true);
    expect(isContinuousTarget("deck:a:play")).toBe(false);
    expect(isContinuousTarget("deck:b:nudge+")).toBe(false);
  });

  it("全ターゲットにラベルがある", () => {
    for (const t of ALL_MIDI_TARGETS) {
      expect(targetLabel(t).length).toBeGreaterThan(0);
    }
  });
});
