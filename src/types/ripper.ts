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
}

/** リッピング中のトラックの工程 (Rust 側 `RipStage`)。 */
export type RipStage = "reading" | "encoding";

export type RipProgress =
  | { kind: "start"; total: number }
  | { kind: "trackStart"; index: number; total: number; label: string }
  // percent はトラック全体 (読み取り 0〜90 / エンコード開始で 90) に対する割合。
  | { kind: "trackProgress"; index: number; percent: number; stage: RipStage }
  | { kind: "trackDone"; index: number; outputPath: string }
  | { kind: "done"; writtenFiles: string[]; addedTracks: number }
  | { kind: "error"; message: string };
