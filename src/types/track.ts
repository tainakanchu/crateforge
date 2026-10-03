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
  // --- 技術メタデータ (#171)。ファイル由来で、未取得なら null。
  // 旧バージョンのサーバー (LAN API) からは欠ける可能性があるので optional にする。
  /** 音声ビットレート (kbps)。 */
  bitrateKbps?: number | null;
  /** サンプルレート (Hz)。 */
  sampleRateHz?: number | null;
  /** ビット深度 (ロスレス / PCM 系のみ)。 */
  bitDepth?: number | null;
  /** チャンネル数。 */
  channels?: number | null;
  /** ファイルサイズ (bytes)。 */
  fileSizeBytes?: number | null;
  /** コーデック表示名 ("FLAC" / "MP3" / "AAC" / "ALAC" …)。 */
  codec?: string | null;
  /** Key の手動上書き (Camelot, 例 "8A")。未設定なら null/undefined。実効キーは上書き ?? 解析値 (#172)。 */
  keyCamelotUser?: string | null;
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

/// Artists ビュー用のサーバ集約 1 行 (Rust: ArtistRow)。
/// コンピレーションの曲は曲ごとのアーティストではなく "Various Artists" に巻き上がる。
export interface ArtistRow {
  name: string;
  albumCount: number;
  trackCount: number;
  /// アートワーク代表曲。実ファイルがある曲を優先して選ぶ。
  artworkTrackId: number | null;
  /// 代表曲の実ファイルパス (ファイルが無い場合は null)。
  artworkLocationPath: string | null;
}
