// DJ モードの MIDI マッピング層。
// ネイティブ（expo-crateforge-midi）から届く生のチャンネルボイスメッセージを、
// 「MIDI ラーン」で学習したバインディングに従って DJ ストアの操作へ変換する。
// 機種ごとの固定プリセットは持たない — DJM 系ミキサーも汎用 MIDI コントローラも、
// フェーダー/ボタンが CC・Note を送るのでラーンで割り当てられる。
// 変換ロジックは純関数（applyMidiMessage）に寄せ、ネイティブ非依存で単体テストする。

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { type DeckId, NUDGE_DOWN, NUDGE_UP, midiValueTo01 } from "./math";
import { useDj } from "./store";

/** 割り当て可能な操作。deck:<id>:<op> とクロスフェーダー。 */
export type MidiTarget =
  | "xfader"
  | `deck:${DeckId}:${"play" | "cue" | "sync" | "volume" | "tempo" | "nudge-" | "nudge+"}`;

/** ラーン UI に並べる順序つき全ターゲット。 */
export const ALL_MIDI_TARGETS: MidiTarget[] = [
  "deck:a:play",
  "deck:a:cue",
  "deck:a:sync",
  "deck:a:volume",
  "deck:a:tempo",
  "deck:a:nudge-",
  "deck:a:nudge+",
  "deck:b:play",
  "deck:b:cue",
  "deck:b:sync",
  "deck:b:volume",
  "deck:b:tempo",
  "deck:b:nudge-",
  "deck:b:nudge+",
  "xfader",
];

const TARGET_SET = new Set<string>(ALL_MIDI_TARGETS);

/** 連続値（フェーダー/ノブ）ターゲットか。それ以外はボタン扱い。 */
export function isContinuousTarget(target: MidiTarget): boolean {
  return target === "xfader" || target.endsWith(":volume") || target.endsWith(":tempo");
}

/** ラーン UI 表示用ラベル。 */
export function targetLabel(target: MidiTarget): string {
  if (target === "xfader") return "クロスフェーダー";
  const [, deck, op] = target.split(":");
  const deckLabel = deck === "a" ? "デッキA" : "デッキB";
  const opLabel =
    op === "play" ? "PLAY/PAUSE"
    : op === "cue" ? "CUE"
    : op === "sync" ? "SYNC"
    : op === "volume" ? "フェーダー"
    : op === "tempo" ? "テンポ"
    : op === "nudge-" ? "ナッジ −"
    : "ナッジ ＋";
  return `${deckLabel} ${opLabel}`;
}

/**
 * バインディングキー。コントローラの 1 操作子を「メッセージ種別:チャンネル:番号」で
 * 同定する（値は含めない）。例: "cc:0:17"（ch1 の CC#17）, "note:3:12"。
 */
export type MidiBindingKey = string;

/** 受信メッセージの最小形（ネイティブイベントの部分集合）。 */
export interface MidiMessageLike {
  status: number;
  data1: number;
  data2: number;
}

/**
 * メッセージからバインディングキーを求める。CC / NoteOn / NoteOff 以外
 * （ピッチベンド等）は対象外で null。NoteOff は同じ操作子の Note キーに正規化する。
 */
export function bindingKeyOf(msg: MidiMessageLike): MidiBindingKey | null {
  const type = msg.status & 0xf0;
  const channel = msg.status & 0x0f;
  if (type === 0xb0) return `cc:${channel}:${msg.data1}`;
  if (type === 0x90 || type === 0x80) return `note:${channel}:${msg.data1}`;
  return null;
}

/** ターゲット → バインディングキー（1 ターゲット 1 操作子）。 */
export type MidiMapping = Partial<Record<MidiTarget, MidiBindingKey>>;

const BINDING_KEY_RE = /^(cc|note):(\d|1[0-5]):(\d{1,3})$/;

/** SecureStore に永続化された JSON を検証つきでパースする。不正値は捨てる。 */
export function parseStoredMapping(raw: string | null): MidiMapping {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const mapping: MidiMapping = {};
    for (const [target, key] of Object.entries(parsed)) {
      if (!TARGET_SET.has(target)) continue;
      if (typeof key !== "string" || !BINDING_KEY_RE.test(key)) continue;
      mapping[target as MidiTarget] = key;
    }
    return mapping;
  } catch {
    return {};
  }
}

/**
 * ボタン操作子の押下/解放を判定する。
 * - NoteOn (velocity>0) = 押下 / NoteOff または velocity 0 = 解放。
 * - CC は値 64 以上 = 押下 / 未満 = 解放（DJM 系の CUE ボタンは 127/0 を送る）。
 */
function buttonEdge(msg: MidiMessageLike): "press" | "release" {
  const type = msg.status & 0xf0;
  if (type === 0x80) return "release";
  if (type === 0x90) return msg.data2 > 0 ? "press" : "release";
  return msg.data2 >= 64 ? "press" : "release";
}

/** DJ ストアのうち MIDI から叩く操作（テストでモック差し替え可能に）。 */
export interface DjMidiApi {
  togglePlay: (deck: DeckId) => void;
  pressCue: (deck: DeckId) => void;
  sync: (deck: DeckId) => boolean;
  setVolume: (deck: DeckId, volume: number) => void;
  setTempo: (deck: DeckId, tempo: number) => void;
  setCrossfader: (x: number) => void;
  setNudge: (deck: DeckId, factor: number | null) => void;
}

/**
 * 受信メッセージをマッピングに従って DJ 操作へ変換する。処理したら true。
 * - 連続値: CC 値 0..127 を 0..1（テンポは -1..1）へ正規化。
 * - ボタン: 押下エッジで発火。ナッジのみ押下/解放でホールド動作。
 */
export function applyMidiMessage(
  msg: MidiMessageLike,
  mapping: MidiMapping,
  api: DjMidiApi,
): boolean {
  const key = bindingKeyOf(msg);
  if (key == null) return false;
  let handled = false;
  // マッピングは高々 15 エントリなので線形走査で十分（1 操作子を複数ターゲットに
  // 割り当てた場合も全て発火させる）。
  for (const [target, bound] of Object.entries(mapping) as [MidiTarget, MidiBindingKey][]) {
    if (bound !== key) continue;
    handled = true;
    if (target === "xfader") {
      api.setCrossfader(midiValueTo01(msg.data2));
      continue;
    }
    const [, deck, op] = target.split(":") as [string, DeckId, string];
    switch (op) {
      case "volume":
        api.setVolume(deck, midiValueTo01(msg.data2));
        break;
      case "tempo":
        api.setTempo(deck, midiValueTo01(msg.data2) * 2 - 1);
        break;
      case "play":
        if (buttonEdge(msg) === "press") api.togglePlay(deck);
        break;
      case "cue":
        if (buttonEdge(msg) === "press") api.pressCue(deck);
        break;
      case "sync":
        if (buttonEdge(msg) === "press") api.sync(deck);
        break;
      case "nudge-":
        api.setNudge(deck, buttonEdge(msg) === "press" ? NUDGE_DOWN : null);
        break;
      case "nudge+":
        api.setNudge(deck, buttonEdge(msg) === "press" ? NUDGE_UP : null);
        break;
    }
  }
  return handled;
}

/**
 * ラーン対象のバインディングに使えるメッセージか。
 * ボタンの解放（NoteOff / velocity 0）では学習しない — 押した瞬間の操作子で覚える。
 * CC はフェーダーを動かした時点の任意の値で学習してよい。
 */
export function isLearnableMessage(msg: MidiMessageLike): boolean {
  const type = msg.status & 0xf0;
  if (type === 0xb0) return true;
  if (type === 0x90) return msg.data2 > 0;
  return false;
}

const KEY_MAPPING = "crateforge.djMidiMapping";

export interface DjMidiState {
  /** 学習済みマッピング（SecureStore に永続化）。 */
  mapping: MidiMapping;
  /** ラーン待ちのターゲット。null なら通常ディスパッチ。 */
  learnTarget: MidiTarget | null;

  setLearnTarget: (target: MidiTarget | null) => void;
  /** ターゲットへバインディングを設定し永続化する。 */
  bind: (target: MidiTarget, key: MidiBindingKey) => void;
  /** ターゲットのバインディングを外し永続化する。 */
  clearBinding: (target: MidiTarget) => void;
  clearAll: () => void;
  /** 起動時（DJ 画面初回マウント）に SecureStore から復元する。 */
  hydrate: () => Promise<void>;

  /**
   * ネイティブからの受信口。ラーン待ちなら学習、そうでなければ DJ ストアへ
   * ディスパッチする。
   */
  handleMessage: (msg: MidiMessageLike) => void;
}

function persist(mapping: MidiMapping): void {
  void SecureStore.setItemAsync(KEY_MAPPING, JSON.stringify(mapping)).catch(() => {});
}

export const useDjMidi = create<DjMidiState>((set, get) => ({
  mapping: {},
  learnTarget: null,

  setLearnTarget: (target) => set({ learnTarget: target }),

  bind: (target, key) => {
    const mapping = { ...get().mapping, [target]: key };
    set({ mapping, learnTarget: null });
    persist(mapping);
  },

  clearBinding: (target) => {
    const mapping = { ...get().mapping };
    delete mapping[target];
    set({ mapping });
    persist(mapping);
  },

  clearAll: () => {
    set({ mapping: {}, learnTarget: null });
    persist({});
  },

  hydrate: async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY_MAPPING);
      set({ mapping: parseStoredMapping(raw) });
    } catch {
      // 読み出し失敗は空マッピングのまま。
    }
  },

  handleMessage: (msg) => {
    const { learnTarget, mapping } = get();
    if (learnTarget != null) {
      if (!isLearnableMessage(msg)) return;
      const key = bindingKeyOf(msg);
      if (key == null) return;
      get().bind(learnTarget, key);
      return;
    }
    applyMidiMessage(msg, mapping, useDj.getState());
  },
}));

/** テスト用：ストアを初期状態へ戻す。 */
export function resetDjMidi(): void {
  useDjMidi.setState({ mapping: {}, learnTarget: null });
}
