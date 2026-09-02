import type { RepeatMode } from "./edit";

export interface PlaybackState {
  isPlaying: boolean;
  currentTrackId: number | null;
  positionMs: number;
  durationMs: number;
  /// Rust 側プレイヤーが持つ実際の値。リモート API からも変わるので
  /// ポーリングでストアへ反映する (App.tsx)。
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
}

export type ViewMode =
  | "library"
  | "playlist"
  | "recent"
  | "artists"
  | "inbox";

/// 検索の対象範囲。プレイリスト表示中だけ意味を持ち、"playlist" はそのプレイリストの中、
/// "library" はライブラリ全体を検索する。
export type SearchScope = "playlist" | "library";

/// 中央ペインの描画モード（どのコレクションを見ているかとは独立）。
export type DisplayMode = "list" | "albums" | "tracks";

/// List のアートワークサイズ（なし / 豆 / 小）。
export type CoverSize = 0 | 20 | 28;

/// 右レールのタブ。
export type RailTab = "now" | "next" | "crate" | "similar";
