export interface PlaybackState {
  isPlaying: boolean;
  currentTrackId: number | null;
  positionMs: number;
  durationMs: number;
}

export type ViewMode = "library" | "playlist" | "recent" | "albums" | "artists";

/// 中央ペインの描画モード（どのコレクションを見ているかとは独立）。
export type DisplayMode = "list" | "albums" | "tracks";

/// List のアートワークサイズ（なし / 豆 / 小）。
export type CoverSize = 0 | 20 | 28;

/// 右レールのタブ。
export type RailTab = "now" | "next" | "crate" | "similar";
