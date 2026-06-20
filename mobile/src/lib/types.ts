// Crateforge LAN API の DTO 群。
// 出典: src-tauri/src/models.rs と src-tauri/src/api/handlers.rs（serde は全て rename_all="camelCase"）。
// ここを唯一の真実として全スライスが import する。フィールド名・null 許容は Rust 側と厳密に一致させること。

/** 1 曲。`Option<T>` は `T | null` に対応。`bool` は非 Option。 */
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
  /** 0-100 スケール（star4 = 80）。 */
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
  /** アプリ内で最後に再生した時刻（ISO8601 UTC）。未再生なら null。 */
  lastPlayed: string | null;
}

/** プレイリスト（フォルダ含む）。 */
export interface Playlist {
  id: number;
  playlistId: number;
  persistentId: string | null;
  parentPersistentId: string | null;
  name: string;
  isFolder: boolean;
  isSmart: boolean;
  isUserCreated: boolean;
  trackCount: number;
}

/** `GET /api/playlists/{id}` は Playlist に smartCriteria を足した形（criteria は不定形なので unknown）。 */
export interface PlaylistDetail extends Playlist {
  smartCriteria: unknown | null;
}

/** ジャンルタグの頻度。 */
export interface GenreTagCount {
  tag: string;
  count: number;
}

/** `GET /api/albums` の 1 件（distinct アルバム）。sampleTrackId はアートワーク取得用の代表トラック。 */
export interface Album {
  album: string;
  albumArtist: string | null;
  trackCount: number;
  sampleTrackId: number;
}

/** クライアント側で全曲から集計したアーティスト 1 件。 */
export interface Artist { artist: string; trackCount: number; sampleTrackId: number; }

/** デスクトップ側の再生状態（`/api/remote/state`）。 */
export interface PlaybackState {
  isPlaying: boolean;
  currentTrackId: number | null;
  positionMs: number;
  durationMs: number;
}

/** 類似曲ヒット（`/api/tracks/{id}/similar`）。distance は小さいほど近い。 */
export interface SimilarHit {
  track: Track;
  distance: number;
}

/** `/api/health`。 */
export interface Health {
  name: string;
  version: string;
  trackCount: number;
}

/** `/api/stats`。 */
export interface LibraryStats {
  trackCount: number;
  playlistCount: number;
  totalTimeMs: number;
}

/** `/api/remote/queue`。currentIndex は未再生時 null。 */
export interface RemoteQueue {
  trackIds: number[];
  currentIndex: number | null;
}

/** `GET /api/tracks` のクエリ（全て任意・camelCase）。 */
export interface TracksQuery {
  q?: string;
  /** rating 下限（0-100）。 */
  ratingMin?: number;
  /** rating 上限（0-100）。 */
  ratingMax?: number;
  /** genre 部分一致（小文字比較）。 */
  genre?: string;
  /** album 部分一致（小文字比較）。 */
  album?: string;
  yearFrom?: number;
  yearTo?: number;
  /** true=解析済みのみ / false=未解析のみ。 */
  analyzed?: boolean;
  limit?: number;
  offset?: number;
  /** DB の sort_field（例: name / artist / dateAdded …）。 */
  sort?: string;
  /** asc / desc。 */
  order?: string;
}

export type TrackMetaField = "bpm" | "year" | "genre" | "rating" | "playCount";
export type SortField = "name" | "artist" | "album" | "year" | "rating" | "playCount" | "bpm" | "dateAdded";
export type SortOrder = "asc" | "desc";
export interface TrackSort { field: SortField; order: SortOrder; }

/** オフラインダウンロードの音質。`original` は無変換、それ以外は AAC への再エンコード。 */
export type DownloadQuality = "original" | "aac256" | "aac192" | "aac128";

/** ダウンロード済み 1 曲のメタ（index.json に永続化される）。 */
export interface DownloadEntry {
  trackId: number;
  track: Track;
  /** 端末ローカルの file:// URI。 */
  localUri: string;
  quality: DownloadQuality;
  /** ファイルサイズ（bytes）。取得不能なら 0。 */
  bytes: number;
  /** ダウンロード時刻（epoch ms）。 */
  createdAt: number;
}

/** `GET /api/tracks/{id}/similar` のクエリ。 */
export interface SimilarQuery {
  limit?: number;
  /** BPM 許容差（base BPM に対する割合）。 */
  bpmTol?: number;
  /** Camelot 互換キーのみに絞る。 */
  keyCompatible?: boolean;
  /** エネルギー許容差（0..1 の絶対差）。 */
  energyTol?: number;
}

/** `GET /api/playlists/{id}/tracks` のクエリ。 */
export interface PlaylistTracksQuery {
  limit?: number;
  offset?: number;
  sort?: string;
  order?: string;
}
