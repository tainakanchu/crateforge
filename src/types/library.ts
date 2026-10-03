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

/** 技術メタデータ一括再読み取り (#171) の結果 (Rust: TechMetaRefreshSummary)。 */
export interface TechMetaRefreshSummary {
  /** 対象 (未取得列がある曲) の総数 */
  total: number;
  /** 読み直して更新できた曲数 */
  updated: number;
  /** ファイルが見つからなかった曲数 */
  missing: number;
  /** ファイルはあるが読めなかった曲数 (非対応形式・破損など) */
  failed: number;
}

export interface LibraryStats {
  trackCount: number;
  playlistCount: number;
  totalTimeMs: number;
}
