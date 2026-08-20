// DJ モードの純粋計算ロジック。UI / ストア / MIDI から共有し、単体テストの対象にする。
// - クロスフェーダーは等パワー則（constant power）。中央で各デッキ ≈ -3dB（0.707）。
// - テンポは「フェーダー位置 (-1..1) × レンジ (±4/8/16%)」で再生レートに変換する。
//   expo-audio (ExoPlayer / AVPlayer) はレート変更時にピッチを保持するので
//   ざっくりマスターテンポ相当の挙動になる。

export type DeckId = "a" | "b";

/** 反対側のデッキ。SYNC の基準取得に使う。 */
export function otherDeck(deck: DeckId): DeckId {
  return deck === "a" ? "b" : "a";
}

/** 汎用 clamp。 */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 0..1 へ clamp。フェーダー系の正規化に使う。 */
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** 選択可能なテンポレンジ（±4% / ±8% / ±16%）。 */
export const TEMPO_RANGES = [0.04, 0.08, 0.16] as const;

/** 既定のテンポレンジ（±8% — 現場での標準）。 */
export const DEFAULT_TEMPO_RANGE = 0.08;

/** 次のテンポレンジ（トグル用: 4 → 8 → 16 → 4 …）。未知値は既定へ戻す。 */
export function nextTempoRange(range: number): number {
  const i = TEMPO_RANGES.findIndex((r) => r === range);
  if (i < 0) return DEFAULT_TEMPO_RANGE;
  return TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length];
}

/**
 * クロスフェーダー位置 x (0=A側 .. 1=B側) から各デッキのゲインを求める（等パワー則）。
 * 端では完全に片側のみ、中央では両デッキ cos(π/4) ≈ 0.707。
 */
export function crossfaderGains(x: number): { a: number; b: number } {
  const t = clamp01(x);
  return {
    a: Math.cos((t * Math.PI) / 2),
    b: Math.sin((t * Math.PI) / 2),
  };
}

/** テンポフェーダー位置 (-1..1) → 再生レート。range は 0.08 (±8%) など。 */
export function tempoToRate(tempo: number, range: number): number {
  return 1 + clamp(tempo, -1, 1) * range;
}

/** 再生レート → テンポフェーダー位置 (-1..1)。range=0 は 0 を返す（ゼロ除算回避）。 */
export function rateToTempo(rate: number, range: number): number {
  if (range <= 0) return 0;
  return clamp((rate - 1) / range, -1, 1);
}

/** 実効 BPM（曲の BPM × 再生レート）。BPM 不明 (null/0) は null。 */
export function effectiveBpm(bpm: number | null, rate: number): number | null {
  if (bpm == null || bpm <= 0) return null;
  return bpm * rate;
}

/**
 * SYNC: 自デッキの BPM を相手デッキの実効 BPM に合わせるテンポフェーダー位置を求める。
 * - どちらかの BPM が不明なら null（同期不能）。
 * - 必要レートがレンジ外なら -1..1 に clamp した値を返す（近づけるだけ近づける）。
 */
export function syncTempo(
  ownBpm: number | null,
  otherBpm: number | null,
  otherTempo: number,
  range: number,
): number | null {
  if (ownBpm == null || ownBpm <= 0 || otherBpm == null || otherBpm <= 0) return null;
  const targetRate = (otherBpm * tempoToRate(otherTempo, range)) / ownBpm;
  return rateToTempo(targetRate, range);
}

/** テンポ表示（例: "+3.2%" / "-0.8%" / "0.0%"）。 */
export function formatTempoPercent(tempo: number, range: number): string {
  const pct = clamp(tempo, -1, 1) * range * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/** MIDI の 7bit 値 (0..127) を 0..1 に正規化。 */
export function midiValueTo01(value: number): number {
  return clamp01(value / 127);
}

/** ピッチベンド（一時的なレート倍率）。ホールド中のみ適用する。 */
export const NUDGE_UP = 1.02;
export const NUDGE_DOWN = 0.98;
