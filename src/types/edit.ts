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
  compilation?: boolean;
  /** Key の手動上書き (Camelot)。文字列で設定、null で解除 (解析値へ戻す)。 */
  keyCamelotUser?: string | null;
}

export interface GenreTagCount {
  tag: string;
  count: number;
}

/** first-class Tag (Genre とは独立)。namespace 空文字 = free tag。 */
export interface Tag {
  id: number;
  namespace: string;
  value: string;
}

/** タグ + 付与曲数。 */
export interface TagCount {
  id: number;
  namespace: string;
  value: string;
  count: number;
}

/** 表示用: `mood:dreamy` / free は `bridge`。 */
export function formatTagStr(namespace: string, value: string): string {
  return namespace ? `${namespace}:${value}` : value;
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
  // プレイリスト固有の「手動順」。DB の playlist_tracks.sort_index 順を指す
  // 疑似フィールドで、ローダは sortField を渡さない (= DB 既定の並び) ことで表現する。
  | "playlistOrder"
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
  | "dateAdded"
  | "lastPlayed"
  // 技術メタデータ (#171)。DB 側 sort_field_to_column と揃える。
  | "bitrate"
  | "sampleRate"
  | "bitDepth"
  | "channels"
  | "fileSize"
  | "codec"
  // Artists ビュー専用 (アーティスト粒度の集約値)。List / Albums では使わない。
  | "trackCount"
  | "albumCount";

export type SortOrder = "asc" | "desc";

/// Albums 表示モードで使うアルバム粒度のソートフィールド集合。
/// トラック専用 (bpm/trackNumber/totalTimeMs 等) はアルバム集約では無意味なので除外する。
export const ALBUM_SORT_FIELDS: SortField[] = [
  "albumArtist",
  "album",
  "year",
  "dateAdded",
  "rating",
  "playCount",
];

/// Artists ビュー (viewMode = "artists") で使えるソートフィールド集合。
/// サーバ (db 側 artist_order_by) が受け付けるのもこの 3 つだけ。
export const ARTIST_SORT_FIELDS: SortField[] = ["name", "trackCount", "albumCount"];

// === 設定可能フィールド（List ビューの列） ===
// Track の identity（カバー + 曲名 + アーティスト）は常時表示の先頭セルで、
// ここに含めない。ここで定義するのは右側の固定幅フィールド群。
export type FieldKey =
  | "rowIndex"
  | "artist"
  | "bpm"
  | "key"
  | "energy"
  | "album"
  | "genre"
  | "rating"
  | "year"
  | "plays"
  | "time"
  | "albumArtist"
  | "trackNumber"
  | "dateAdded"
  | "lastPlayed"
  | "codec"
  | "bitrate"
  | "sampleRate"
  | "bitDepth"
  | "channels"
  | "fileSize";

export interface FieldDef {
  key: FieldKey;
  label: string;
  /// 固定幅 px。
  width: number;
  /// ソート対象の SortField（null = ソート不可）。
  sortField: SortField | null;
}

// 列名は日本語 (BPM / Key / Energy などの固有語は英語のまま)。ツールバーの並び順・
// Track Info・スマートプレイリストの項目名もこの呼び方にそろえる (D8)。
// 既定列 (DEFAULT_FIELDS) の幅は、1280x800 で右ペインを出した既定状態
// (一覧の表示幅 ≈ 730px、縦スクロールバー 10px 込み) に曲名列の最小 180px と合わせて
// 収まるよう詰めてある (D2)。
export const FIELD_DEFS: Record<FieldKey, FieldDef> = {
  // 現在の表示順での連番 (1,2,3…)。アルバムのトラック番号(trackNumber)とは別物。
  // 表示インデックスを描画するだけなのでソート対象外 (sortField: null)。
  rowIndex: { key: "rowIndex", label: "No.", width: 48, sortField: null },
  artist: { key: "artist", label: "アーティスト", width: 110, sortField: "artist" },
  bpm: { key: "bpm", label: "BPM", width: 56, sortField: "bpm" },
  // key / energy は track_analysis 由来。tracks テーブルに無いのでソート対象外 (sortField: null)。
  key: { key: "key", label: "Key", width: 56, sortField: null },
  energy: { key: "energy", label: "Energy", width: 72, sortField: null },
  album: { key: "album", label: "アルバム", width: 120, sortField: "album" },
  genre: { key: "genre", label: "ジャンル", width: 92, sortField: "genre" },
  rating: { key: "rating", label: "評価", width: 84, sortField: "rating" },
  year: { key: "year", label: "年", width: 56, sortField: "year" },
  plays: { key: "plays", label: "再生回数", width: 56, sortField: "playCount" },
  time: { key: "time", label: "時間", width: 60, sortField: "totalTimeMs" },
  albumArtist: { key: "albumArtist", label: "アルバムアーティスト", width: 150, sortField: "albumArtist" },
  trackNumber: { key: "trackNumber", label: "曲番号", width: 64, sortField: "trackNumber" },
  dateAdded: { key: "dateAdded", label: "追加日", width: 104, sortField: "dateAdded" },
  lastPlayed: { key: "lastPlayed", label: "最終再生", width: 104, sortField: "lastPlayed" },
  // 技術メタデータ (#171)。未取得の曲は空欄 (設定 → 技術情報を再読み取り で埋まる)。
  codec: { key: "codec", label: "コーデック", width: 64, sortField: "codec" },
  bitrate: { key: "bitrate", label: "ビットレート", width: 76, sortField: "bitrate" },
  sampleRate: { key: "sampleRate", label: "サンプルレート", width: 88, sortField: "sampleRate" },
  bitDepth: { key: "bitDepth", label: "ビット深度", width: 72, sortField: "bitDepth" },
  channels: { key: "channels", label: "チャンネル", width: 72, sortField: "channels" },
  fileSize: { key: "fileSize", label: "サイズ", width: 80, sortField: "fileSize" },
};

/// ColumnPicker の "Available" 列挙順。
export const ALL_FIELDS: FieldKey[] = [
  "rowIndex",
  "artist",
  "bpm",
  "key",
  "energy",
  "album",
  "genre",
  "rating",
  "year",
  "plays",
  "time",
  "albumArtist",
  "trackNumber",
  "dateAdded",
  "lastPlayed",
  "codec",
  "bitrate",
  "sampleRate",
  "bitDepth",
  "channels",
  "fileSize",
];

/// 既定の表示列（順序 = 表示順）。
export const DEFAULT_FIELDS: FieldKey[] = ["artist", "bpm", "album", "genre", "rating"];

/// v23 以前の既定列。永続化された列がこれと同じなら v24 で Artist 列入りの既定へ移行する。
export const LEGACY_DEFAULT_FIELDS_V23: FieldKey[] = ["bpm", "album", "genre", "rating"];
