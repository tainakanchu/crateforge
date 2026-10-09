// USB 書き出し (rekordbox 互換 / CDJ 向け、外部 rbx-cli) の型。
// Rust 側 (src-tauri/src/usb_export/, commands/usb_export.rs, rbx_cli.rs) と 1:1 で対応する。

/** 書き出し設定 (`UsbExportOptions`)。 */
export interface UsbExportOptions {
  /** 書き出すプレイリスト / フォルダ (フォルダは配下を階層ごと)。 */
  playlistIds: number[];
  /** USB のルート (マウントポイント) またはフォルダ。 */
  destination: string;
  /** Traktor のキュー / グリッドを使う。 */
  useTraktor: boolean;
  /** この書き出しで使う collection.nml (null なら保存済みの指定 → 自動検出)。 */
  nmlPath: string | null;
  /** MP3 のキュー / グリッド補正 (ms)。既定 0。 */
  mp3OffsetMs: number;
  /** 埋め込みアートワークを書き出す。 */
  artwork: boolean;
  /** 今回の内容に無い曲を USB から消す。 */
  prune: boolean;
  /** プレーヤーに表示するデバイス名 (空なら変更しない)。 */
  deviceName: string | null;
  /**
   * CDJ で変更したキュー / グリッドを優先する (rbx-cli `onDeviceChanges: "keepDevice"`)。
   * 前回の同期の後に USB 上で変わった曲だけ、その同期では USB 上のキュー / グリッドを残す。
   */
  keepDeviceChanges: boolean;
}

export interface TraktorReport {
  nmlPath: string;
  entries: number;
  matched: number;
  matchedByName: number;
  /** 一致しなかった曲 (曖昧だった曲を含む)。 */
  unmatched: number;
  unmatchedExamples: string[];
  /** 候補が複数あって決められなかった曲 (別ボリュームに同じパスの曲がある等)。 */
  ambiguous: number;
  ambiguousExamples: string[];
  withCues: number;
  withGrid: number;
  mp3OffsetMs: number;
}

/** crateforge 側でのリクエスト作成結果。 */
export interface UsbBuildReport {
  tracks: number;
  playlists: number;
  folders: number;
  /** ファイルが見つかった曲。 */
  found: number;
  /** ファイルが見つからない曲 (パスがあれば rbx-cli に渡し、判断を任せる)。 */
  missing: number;
  missingExamples: string[];
  traktor: TraktorReport | null;
  warnings: string[];
}

export interface UsbTrackCounts {
  requested: number;
  exported: number;
  copied: number;
  reused: number;
  skipped: number;
  removed: number;
  kept: number;
  /** keepDevice で USB 上のキュー / グリッドを残した曲 (dry-run では残す見込みの曲)。 */
  deviceChangesKept: number;
}

export interface UsbAnalysisCounts {
  generated: number;
  cacheHits: number;
  deviceReuse: number;
  supplied: number;
  none: number;
  failed: number;
  cacheMisses: number;
  gridOverrides: number;
  cueOverrides: number;
}

export interface UsbTrackResult {
  index: number;
  ref: string | null;
  title: string;
  /** exported | skipped | planned */
  status: string;
  /** cache | generated | device | supplied | none | failed | generate */
  analysis: string;
  /** dry-run のみ: copy | reuse */
  audio: string | null;
  /** keepDevice で USB 上のキュー / グリッドを残した (dry-run では残す見込み)。 */
  deviceChangesKept: boolean;
  analysisDir: string | null;
  warnings: string[];
}

/** rbx-cli `usb export` の結果 (dry-run でも同形)。 */
export interface UsbExportResult {
  destination: string;
  root: string;
  dryRun: boolean;
  tracks: UsbTrackCounts;
  playlists: { written: number; added: number; removed: number };
  analysis: UsbAnalysisCounts;
  bytes: { copied: number; reused: number; toCopy: number; free: number | null };
  verified: boolean | null;
  timings: { planMs: number; analyzeMs: number; exportMs: number; verifyMs: number; totalMs: number };
  items: UsbTrackResult[];
}

export interface UsbExportPlan {
  build: UsbBuildReport;
  result: UsbExportResult;
}

/** UI 向けエラー (コマンドの reject 値 / failed イベント)。 */
export interface UsbExportError {
  code: string;
  /** 日本語のメッセージ。 */
  message: string;
  /** rbx-cli の原文 (調査用)。 */
  detail: string;
  /**
   * CDJ 等で USB 上のキュー / グリッドが変わったための競合 (`cues_or_grid_changed_on_device`)。
   * 「CDJ の変更を優先」(keepDevice) での再試行で解決できる。
   */
  cueConflict: boolean;
  /** conflict の理由 (rbx-cli の details.reason)。conflict 以外は null。 */
  reason: string | null;
  /** 競合に関係する曲 (crateforge の曲名に対応付け済み)。 */
  conflictTracks: UsbConflictTrack[];
}

/** 競合に関係する曲。 */
export interface UsbConflictTrack {
  /** リクエストの tracks の添字。 */
  index: number;
  title: string;
  artist: string | null;
  path: string | null;
}

export type UsbJobKind = "plan" | "export";

/** `usb-export-progress` のイベント本体。phase: plan / analyze / check / copy / database / verify / publish */
export type UsbExportProgressEvent =
  | { kind: "started"; job: UsbJobKind; tracks: number; destination: string }
  | {
      kind: "phase";
      job: UsbJobKind;
      phase: string;
      current: number;
      total: number;
      title: string | null;
    }
  | { kind: "trackSkipped"; job: UsbJobKind; index: number | null; path: string; reason: string }
  | { kind: "trackWarning"; job: UsbJobKind; index: number | null; message: string }
  | { kind: "log"; job: UsbJobKind; level: string; message: string }
  | { kind: "finished"; job: UsbJobKind; result: UsbExportResult }
  | { kind: "failed"; job: UsbJobKind; error: UsbExportError };

/** `usb-export-progress` イベント。runId はバックエンドが実行ごとに振る id。 */
export type UsbExportProgress = UsbExportProgressEvent & { runId: number };

/** `usb_export_start` の戻り値。 */
export interface UsbExportStarted {
  /** この書き出しの run id (以降のイベントの runId)。 */
  runId: number;
  report: UsbBuildReport;
}

export interface UsbExportJobStatus {
  running: boolean;
  job: UsbJobKind | null;
  runId: number | null;
  /** 実行中のジョブの設定 (再読み込み後の復元用)。 */
  options: UsbExportOptions | null;
}

/** 中止する対象 (指定した条件すべてに合う実行だけを止める)。 */
export interface UsbExportCancelTarget {
  runId?: number;
  job?: UsbJobKind;
}

/** rbx-cli `devices list` の 1 ボリューム。 */
export interface UsbDevice {
  name: string;
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
  fileSystem: string;
  removable: boolean;
  volumeId: string;
  export: { tracks: number; playlists: number; ours: boolean; written: string } | null;
}

/** rbx-cli の状態。 */
export interface RbxCliStatus {
  available: boolean;
  path: string | null;
  source: "override" | "cache" | "path" | "none";
  version: string | null;
  protocol: number | null;
  rbxportRev: string | null;
  error: string | null;
  overridePath: string | null;
  pinnedVersion: string;
  canDownload: boolean;
}

export type RbxCliProgress =
  | { kind: "start"; version: string }
  | { kind: "download"; received: number; total: number }
  | { kind: "verify" }
  | { kind: "extract" }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string };

export interface TraktorNmlStatus {
  overridePath: string | null;
  detectedPath: string | null;
  effectivePath: string | null;
  exists: boolean;
}
