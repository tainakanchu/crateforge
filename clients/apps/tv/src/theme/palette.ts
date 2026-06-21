// Crateforge TV テーマ。モバイルアプリの PALETTE と同じ色調を維持しつつ
// 10-foot UI に最適化したサイズ定数を追加する。

export const PALETTE = {
  /** メイン背景（ほぼ黒）*/
  bg: "#0E1416",
  /** カード/セル背景 */
  surface: "#1A2226",
  /** フォーカスリング・アクセント (teal) */
  teal: "#6CA1B5",
  /** テキスト白 */
  text: "#FFFFFF",
  /** 副テキスト（暗め）*/
  textSub: "#8A9DA6",
  /** ボーダー */
  border: "#2A3A42",
  /** フォーカス背景ハイライト */
  focusBg: "#1E3040",
} as const;

/** D-pad / 10-foot UI 向けフォントサイズ */
export const TV_FONT = {
  xs: 18,
  sm: 22,
  md: 28,
  lg: 36,
  xl: 48,
  hero: 64,
} as const;

/** フォーカスリングのスタイル */
export const FOCUS_RING = {
  borderWidth: 3,
  borderColor: PALETTE.teal,
  borderRadius: 8,
} as const;
