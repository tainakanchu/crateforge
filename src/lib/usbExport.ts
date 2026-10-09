// USB 書き出し (rbx-cli) の表示用ヘルパ — 純関数のみ。

import type { Playlist, UsbExportProgress } from "../types";
import type { UsbExportStatus } from "../store/useStore";

/** rbx-cli の工程 (progress の phase) の表示名。順序は rbx-cli の実行順。 */
export const USB_PHASES: { key: string; label: string }[] = [
  { key: "plan", label: "準備" },
  { key: "analyze", label: "解析・タグ読み取り" },
  { key: "check", label: "変更チェック" },
  { key: "copy", label: "USB へコピー" },
  { key: "database", label: "データベース作成" },
  { key: "verify", label: "検証" },
  { key: "publish", label: "反映" },
];

export function usbPhaseLabel(phase: string): string {
  return USB_PHASES.find((p) => p.key === phase)?.label ?? phase;
}

/** 解析の出どころ (items[].analysis) の表示名。 */
export const USB_ANALYSIS_LABELS: Record<string, string> = {
  cache: "キャッシュ",
  generated: "新規解析",
  generate: "新規解析",
  device: "USB 上の解析を再利用",
  supplied: "指定の解析",
  none: "解析なし",
  failed: "解析失敗",
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  const digits = value >= 100 || power === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[power]}`;
}

export function formatDurationMs(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
}

/** 全体進捗 (0〜1)。工程の順番 + 工程内の current/total から概算する。 */
export function usbOverallFraction(s: UsbExportStatus): number {
  if (s.phase === "done") return 1;
  const idx = USB_PHASES.findIndex((p) => p.key === s.stage);
  if (idx < 0) return 0;
  const within = s.total > 0 ? Math.min(1, s.current / s.total) : 0;
  return Math.min(1, (idx + within) / USB_PHASES.length);
}

const MAX_WARNINGS = 200;

/** 実行中の書き出しの初期状態 (started イベント / 開始コマンドの戻り / 再読み込み後の復元)。 */
export function runningUsbExportStatus(
  runId: number,
  destination: string,
  tracks: number,
): UsbExportStatus {
  return {
    runId,
    phase: "running",
    destination,
    tracks,
    stage: "plan",
    current: 0,
    total: tracks,
    title: null,
    skipped: 0,
    warnings: [],
    cancelling: false,
  };
}

/**
 * `usb-export-progress` (job = export) をストアの状態へ畳み込む。
 * plan のイベントはダイアログ側で扱うので prev をそのまま返す。
 * runId で実行を区別する: 今の状態より古い実行のイベントは無視し、新しい実行のイベントは
 * (started を取りこぼしていても) その実行の状態として受け入れる。
 */
export function reduceUsbExportStatus(
  prev: UsbExportStatus | null,
  ev: UsbExportProgress,
): UsbExportStatus | null {
  if (ev.job !== "export") return prev;
  if (prev && ev.runId < prev.runId) return prev; // 古い実行
  if (ev.kind === "started") {
    return runningUsbExportStatus(ev.runId, ev.destination, ev.tracks);
  }
  // 別の (新しい) 実行のイベントが started より先に来た / 再読み込み後: その実行として始める。
  const base: UsbExportStatus =
    prev && prev.runId === ev.runId ? prev : runningUsbExportStatus(ev.runId, "", 0);
  switch (ev.kind) {
    case "phase":
      if (base.phase !== "running") return base;
      return {
        ...base,
        stage: ev.phase,
        current: ev.current,
        total: ev.total,
        title: ev.title ?? base.title,
      };
    case "trackSkipped":
      return {
        ...base,
        skipped: base.skipped + 1,
        warnings:
          base.warnings.length < MAX_WARNINGS
            ? [...base.warnings, `見つからないため書き出しません: ${ev.path}`]
            : base.warnings,
      };
    case "trackWarning":
    case "log":
      return {
        ...base,
        warnings:
          base.warnings.length < MAX_WARNINGS ? [...base.warnings, ev.message] : base.warnings,
      };
    case "finished":
      return {
        ...base,
        destination: base.destination || ev.result.destination,
        tracks: base.tracks || ev.result.tracks.requested,
        phase: "done",
        result: ev.result,
        cancelling: false,
      };
    case "failed":
      return { ...base, phase: "error", error: ev.error, cancelling: false };
    default:
      return prev;
  }
}

/**
 * 開始コマンド (usb_export_start) が戻ったときの状態。イベントが先に届いていれば
 * (同じか新しい runId の状態があれば) それを優先し、上書きしない。
 */
export function startedUsbExportStatus(
  prev: UsbExportStatus | null,
  runId: number,
  destination: string,
  tracks: number,
): UsbExportStatus {
  if (prev && prev.runId >= runId) return prev;
  return runningUsbExportStatus(runId, destination, tracks);
}

/** サイドバーと同じ順で、プレイリストを (深さ付きの) 木順に並べる。 */
export function flattenPlaylistTree(playlists: Playlist[]): { pl: Playlist; depth: number }[] {
  const byParent = new Map<string, Playlist[]>();
  const known = new Set(playlists.map((p) => p.persistentId).filter(Boolean) as string[]);
  const roots: Playlist[] = [];
  for (const p of playlists) {
    const parent = p.parentPersistentId;
    if (parent && known.has(parent)) {
      const list = byParent.get(parent) ?? [];
      list.push(p);
      byParent.set(parent, list);
    } else {
      roots.push(p);
    }
  }
  const out: { pl: Playlist; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (p: Playlist, depth: number) => {
    if (seen.has(p.playlistId) || depth > 64) return;
    seen.add(p.playlistId);
    out.push({ pl: p, depth });
    for (const c of (p.persistentId && byParent.get(p.persistentId)) || []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** 祖先フォルダのいずれかが選ばれているか (フォルダごと書き出されるので個別の選択は不要)。 */
export function hasSelectedAncestor(
  pl: Playlist,
  selected: Set<number>,
  byPid: Map<string, Playlist>,
): boolean {
  let parent = pl.parentPersistentId;
  let guard = 0;
  while (parent && guard++ < 64) {
    const pp = byPid.get(parent);
    if (!pp) return false;
    if (selected.has(pp.playlistId)) return true;
    parent = pp.parentPersistentId;
  }
  return false;
}
