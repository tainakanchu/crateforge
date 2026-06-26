// Crateforge TV テーマ。モバイルアプリの PALETTE と同じ色調を維持しつつ
// 10-foot UI に最適化したサイズ定数を追加する。
// TV は視聴距離が遠いため、フォントはモバイルより一回り大きめに設定。

export const PALETTE = {
  /** メイン背景（ほぼ黒）*/
  bg: "#0E1416",
  /** カード/セル背景 */
  surface: "#1A2226",
  /** サイドナビ背景（bgより少し明るめ）*/
  navBg: "#121A1E",
  /** フォーカスリング・アクセント (teal) */
  teal: "#6CA1B5",
  /** アクティブなナビアイテムの背景 */
  navActive: "#1B3040",
  /** テキスト白 */
  text: "#FFFFFF",
  /** 副テキスト（暗め）*/
  textSub: "#8A9DA6",
  /** ボーダー */
  border: "#2A3A42",
  /** フォーカス背景ハイライト */
  focusBg: "#1E3040",
  /** エラー赤 */
  error: "#E57373",
} as const;

/** D-pad / 10-foot UI 向けフォントサイズ（視聴距離 3m 想定）。 */
export const TV_FONT = {
  xs: 18,
  sm: 22,
  md: 28,
  lg: 36,
  xl: 48,
  hero: 64,
} as const;

/** フォーカスリングのスタイル（Focusable コンポーネントのデフォルト）。 */
export const FOCUS_RING = {
  borderWidth: 3,
  borderColor: PALETTE.teal,
  borderRadius: 8,
} as const;

/** 10ft UI レイアウト定数。 */
export const TV_LAYOUT = {
  /** 左サイドナビの幅（px）。 */
  sideNavWidth: 260,
  /** サイドナビのパディング。 */
  sideNavPaddingH: 16,
  sideNavPaddingV: 24,
  /** コンテンツエリアの水平パディング。 */
  contentPaddingH: 48,
  contentPaddingV: 32,
  /** ナビアイテムの高さ。 */
  navItemHeight: 60,
  /** ミニプレイヤーの高さ。 */
  miniPlayerHeight: 100,
} as const;
