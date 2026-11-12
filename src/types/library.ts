import type { DuplicateHit, ItemAction } from "./ripper";

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

/** `plan_import` の 1 ファイル分 (Rust: ImportPlanItem)。 */
export interface ImportPlanItem {
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  /** 別ファイルとして取り込み済みの一致 (同じパスの曲は含まない)。 */
  hits: DuplicateHit[];
  /** このパスそのものが既にライブラリにある (黙ってスキップする)。 */
  alreadyImportedSamePath: boolean;
  /**
   * 表記の違うパス (リンク / ハードリンク経由など) で同じ実体が登録済みのとき、その登録済みの
   * パス。文字列として同じパスなら null。確認ダイアログで「登録済み（同じファイル）」の行に出す。
   */
  registeredPath?: string | null;
  /** 取り込む側のファイル自体にゼロ埋め破損の疑いがある (既定でスキップ)。 */
  sourceBroken: boolean;
}

export interface ImportActionItem {
  path: string;
  action: ItemAction;
  replaceTrackId?: number | null;
}

export interface ImportActionResult {
  path: string;
  action: ItemAction;
  ok: boolean;
  error: string | null;
  trackId: number | null;
  newPath: string | null;
  oldFileMovedTo: string | null;
}

/** `import_with_actions` の結果 (Rust: ImportActionsSummary)。 */
export interface ImportActionsSummary {
  imported: number;
  skipped: number;
  replaced: number;
  failed: number;
  results: ImportActionResult[];
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

/** リンク切れ再チェック (全曲の実ファイル有無の再確認) の結果 (Rust: FileCheckSummary)。 */
export interface FileCheckSummary {
  /** 確認した曲数 (= ライブラリの全曲数) */
  checked: number;
  /** 確認後にファイルが見つからない曲数 */
  missing: number;
  /** 前回まではあったのに、今回見つからなくなった曲数 */
  newlyMissing: number;
  /** 前回まではリンク切れだったのに、今回見つかった曲数 */
  newlyFound: number;
}

export interface LibraryStats {
  trackCount: number;
  playlistCount: number;
  totalTimeMs: number;
  /** Artists ビューのアーティスト数。 */
  artistCount: number;
}
