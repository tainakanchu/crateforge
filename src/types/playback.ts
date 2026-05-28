export interface PlaybackState {
  isPlaying: boolean;
  currentTrackId: number | null;
  positionMs: number;
  durationMs: number;
}

export type ViewMode = "library" | "playlist" | "recent" | "albums" | "artists";
