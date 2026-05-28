export interface TrackEdit {
  name?: string | null;
  artist?: string | null;
  albumArtist?: string | null;
  composer?: string | null;
  album?: string | null;
  genre?: string | null;
  comments?: string | null;
  year?: number | null;
  bpm?: number | null;
  rating?: number;
  trackNumber?: number | null;
  trackCount?: number | null;
  discNumber?: number | null;
  discCount?: number | null;
}

export interface GenreTagCount {
  tag: string;
  count: number;
}

export interface QueueState {
  trackIds: number[];
  currentIndex: number | null;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
}

export type RepeatMode = "off" | "all" | "one";

export type SortField =
  | "name"
  | "artist"
  | "albumArtist"
  | "album"
  | "genre"
  | "rating"
  | "playCount"
  | "year"
  | "bpm"
  | "trackNumber"
  | "totalTimeMs"
  | "dateAdded";

export type SortOrder = "asc" | "desc";

export interface ColumnConfig {
  key: ColumnKey;
  label: string;
  /// Default visibility.
  defaultVisible: boolean;
  /// Field used for sorting (null = not sortable).
  sortField: SortField | null;
  /// CSS width hint (flex|px).
  width?: string;
  /// Right-align numeric columns.
  numeric?: boolean;
}

export type ColumnKey =
  | "name"
  | "artist"
  | "albumArtist"
  | "album"
  | "genre"
  | "year"
  | "rating"
  | "playCount"
  | "bpm"
  | "totalTimeMs"
  | "trackNumber"
  | "dateAdded";

export const COLUMNS: ColumnConfig[] = [
  { key: "name", label: "Track", defaultVisible: true, sortField: "name", width: "3fr" },
  { key: "artist", label: "Artist", defaultVisible: true, sortField: "artist", width: "2fr" },
  { key: "albumArtist", label: "Album Artist", defaultVisible: false, sortField: "albumArtist", width: "2fr" },
  { key: "album", label: "Album", defaultVisible: true, sortField: "album", width: "2fr" },
  { key: "genre", label: "Genre", defaultVisible: true, sortField: "genre", width: "1.5fr" },
  { key: "year", label: "Year", defaultVisible: false, sortField: "year", width: "60px", numeric: true },
  { key: "rating", label: "Rating", defaultVisible: true, sortField: "rating", width: "80px" },
  { key: "playCount", label: "Plays", defaultVisible: true, sortField: "playCount", width: "50px", numeric: true },
  { key: "bpm", label: "BPM", defaultVisible: true, sortField: "bpm", width: "50px", numeric: true },
  { key: "totalTimeMs", label: "Time", defaultVisible: true, sortField: "totalTimeMs", width: "55px", numeric: true },
  { key: "trackNumber", label: "#", defaultVisible: false, sortField: "trackNumber", width: "40px", numeric: true },
  { key: "dateAdded", label: "Date Added", defaultVisible: false, sortField: "dateAdded", width: "110px" },
];
