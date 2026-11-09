export interface DiscToc {
  freedbId: string;
  musicbrainzId: string | null;
  device: string;
  trackCount: number;
  trackLengthsSec: number[];
  totalSectors: number;
}

export interface ReleaseTrack {
  position: number;
  title: string;
  artist: string;
  lengthMs: number | null;
}

export interface ReleaseCandidate {
  releaseId: string;
  title: string;
  artist: string;
  date: string | null;
  country: string | null;
  barcode: string | null;
  trackCount: number;
  tracks: ReleaseTrack[];
  coverArtUrl: string | null;
}

export type EncodeFormat = "flac" | "mp3" | "alac" | "wav";

export interface RipRequest {
  device: string;
  outputDir?: string;
  format: EncodeFormat;
  tracks: number[];
  release: ReleaseCandidate | null;
  addToLibrary: boolean;
  /** トラックごとの扱い (取り込み済み検出の結果)。指定の無いトラックは取り込む。 */
  trackActions?: RipTrackAction[];
}

/** 取り込み / リップ時の 1 曲ごとの扱い (Rust: ItemAction)。 */
export type ItemAction = "import" | "skip" | "replace";

/** 一致した既存曲のファイル状態 (Rust: FileHealth)。 */
export type FileHealth = "ok" | "missing" | "broken";

/** 照合の確からしさ (Rust: MatchKind)。 */
export type MatchKind = "exact" | "probable" | "weak";

/** 取り込み済み検出で一致した既存曲 (Rust: DuplicateHit)。 */
export interface DuplicateHit {
  trackId: number;
  name: string | null;
  artist: string | null;
  album: string | null;
  totalTimeMs: number | null;
  locationPath: string | null;
  health: FileHealth;
  kind: MatchKind;
}

export interface RipTrackDuplicates {
  position: number;
  hits: DuplicateHit[];
}

export interface RipDuplicateQuery {
  album: string | null;
  albumArtist: string | null;
  tracks: ReleaseTrack[];
}

export interface RipTrackAction {
  position: number;
  action: ItemAction;
  replaceTrackId?: number | null;
}

/** リッピング中のトラックの工程 (Rust 側 `RipStage`)。 */
export type RipStage = "reading" | "encoding";

export type RipProgress =
  | { kind: "start"; total: number }
  | { kind: "trackStart"; index: number; total: number; label: string }
  // percent はトラック全体 (読み取り 0〜90 / エンコード開始で 90) に対する割合。
  | { kind: "trackProgress"; index: number; percent: number; stage: RipStage }
  | { kind: "trackDone"; index: number; outputPath: string }
  | {
      kind: "done";
      writtenFiles: string[];
      addedTracks: number;
      replacedTracks: number;
      movedOldFiles: string[];
      replaceErrors: string[];
    }
  | { kind: "error"; message: string };
