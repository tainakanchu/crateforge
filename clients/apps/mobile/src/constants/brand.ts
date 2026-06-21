// Crateforge ブランド配色。デスクトップのアクセント #6CA1B5（アイコン色）に統一。
// テンプレ既存の Colors（src/constants/theme.ts）は触らず、アプリ固有の色はここに集約する。

export const BRAND = {
  /** デスクトップと統一したアクセント（teal）。 */
  accent: "#6CA1B5",
  accentDim: "#4E7C8C",
  accentText: "#0B1416",
} as const;

/** ダーク基調のパレット（音楽アプリはダーク既定が見やすい）。 */
export const PALETTE = {
  bg: "#0E1416",
  surface: "#161E21",
  surfaceAlt: "#1E282C",
  border: "#26343A",
  text: "#E8EEF0",
  textDim: "#9DB0B7",
  textFaint: "#62757C",
  accent: BRAND.accent,
  accentDim: BRAND.accentDim,
  danger: "#D9534F",
  success: "#5FB37E",
} as const;

export type Palette = typeof PALETTE;
