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

// === 設定可能フィールド（List ビューの列） ===
// Track の identity（カバー + 曲名 + アーティスト）は常時表示の先頭セルで、
// ここに含めない。ここで定義するのは右側の固定幅フィールド群。
export type FieldKey =
  | "bpm"
  | "album"
  | "genre"
  | "rating"
  | "year"
  | "plays"
  | "time"
  | "albumArtist"
  | "trackNumber"
  | "dateAdded";

export interface FieldDef {
  key: FieldKey;
  label: string;
  /// 固定幅 px。
  width: number;
  /// ソート対象の SortField（null = ソート不可）。
  sortField: SortField | null;
}

export const FIELD_DEFS: Record<FieldKey, FieldDef> = {
  bpm: { key: "bpm", label: "BPM", width: 64, sortField: "bpm" },
  album: { key: "album", label: "Album", width: 168, sortField: "album" },
  genre: { key: "genre", label: "Genre", width: 110, sortField: "genre" },
  rating: { key: "rating", label: "Rating", width: 90, sortField: "rating" },
  year: { key: "year", label: "Year", width: 56, sortField: "year" },
  plays: { key: "plays", label: "Plays", width: 56, sortField: "playCount" },
  time: { key: "time", label: "Time", width: 60, sortField: "totalTimeMs" },
  albumArtist: { key: "albumArtist", label: "Album Artist", width: 150, sortField: "albumArtist" },
  trackNumber: { key: "trackNumber", label: "#", width: 44, sortField: "trackNumber" },
  dateAdded: { key: "dateAdded", label: "Date Added", width: 104, sortField: "dateAdded" },
};

/// ColumnPicker の "Available" 列挙順。
export const ALL_FIELDS: FieldKey[] = [
  "bpm",
  "album",
  "genre",
  "rating",
  "year",
  "plays",
  "time",
  "albumArtist",
  "trackNumber",
  "dateAdded",
];

/// 既定の表示列（順序 = 表示順）。
export const DEFAULT_FIELDS: FieldKey[] = ["bpm", "album", "genre", "rating"];
