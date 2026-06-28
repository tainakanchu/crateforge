export interface Track {
  id: number;
  trackId: number;
  persistentId: string | null;
  name: string | null;
  artist: string | null;
  albumArtist: string | null;
  composer: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  rating: number | null;
  playCount: number | null;
  skipCount: number | null;
  totalTimeMs: number | null;
  dateAdded: string | null;
  dateModified: string | null;
  bpm: number | null;
  comments: string | null;
  locationRaw: string | null;
  locationPath: string | null;
  trackType: string | null;
  disabled: boolean;
  compilation: boolean;
  discNumber: number | null;
  discCount: number | null;
  trackNumber: number | null;
  trackCount: number | null;
  fileExists: boolean;
  lastPlayed: string | null;
}

export interface AlbumRow {
  albumKey: string;
  album: string;
  albumArtist: string; // コンピは "Various Artists"
  isCompilation: boolean;
  trackCount: number;
  coverTrackId: number | null;
  coverLocationPath: string | null;
  coverFileExists: boolean;
  totalTimeMs: number;
  year: number | null;
  dateAdded: string | null;
  rating: number | null;
  playCount: number;
  bpmMin: number | null;
  bpmMax: number | null;
}
