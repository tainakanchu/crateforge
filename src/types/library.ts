export interface ImportResult {
  trackCount: number;
  playlistCount: number;
  missingFiles: number;
}

export interface ExportResult {
  outputPath: string;
  trackCount: number;
  playlistCount: number;
}

export interface ImportFileResult {
  addedTracks: number;
  skipped: number;
}

/**
 * フォルダ取り込み (`import_folders`) の結果。
 * - imported: 新しく追加できた曲数
 * - skipped:  既にライブラリにあるパスなので飛ばした数
 * - failed:   読み込み/追加に失敗した数
 */
export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
}

export interface LibraryStats {
  trackCount: number;
  playlistCount: number;
  totalTimeMs: number;
}
