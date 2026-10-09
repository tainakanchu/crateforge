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

/**
 * `usb-export-progress` (job = export) をストアの状態へ畳み込む。
 * plan のイベントはダイアログ側で扱うので null 以外の prev をそのまま返す。
 */
export function reduceUsbExportStatus(
  prev: UsbExportStatus | null,
  ev: UsbExportProgress,
): UsbExportStatus | null {
  if (ev.job !== "export") return prev;
  switch (ev.kind) {
    case "started":
      return {
        phase: "running",
        destination: ev.destination,
        tracks: ev.tracks,
        stage: "plan",
        current: 0,
        total: ev.tracks,
        title: null,
        skipped: 0,
        warnings: [],
        cancelling: false,
      };
    case "phase":
      if (!prev) return prev;
      return {
        ...prev,
        stage: ev.phase,
        current: ev.current,
        total: ev.total,
        title: ev.title ?? prev.title,
      };
    case "trackSkipped":
      if (!prev) return prev;
      return {
        ...prev,
        skipped: prev.skipped + 1,
        warnings:
          prev.warnings.length < MAX_WARNINGS
            ? [...prev.warnings, `見つからないため書き出しません: ${ev.path}`]
            : prev.warnings,
      };
    case "trackWarning":
    case "log":
      if (!prev) return prev;
      return {
        ...prev,
        warnings:
          prev.warnings.length < MAX_WARNINGS ? [...prev.warnings, ev.message] : prev.warnings,
      };
    case "finished":
      return {
        ...(prev ?? {
          destination: ev.result.destination,
          tracks: ev.result.tracks.requested,
          stage: "publish",
          current: 0,
          total: 0,
          title: null,
          skipped: 0,
          warnings: [],
          cancelling: false,
        }),
        phase: "done",
        result: ev.result,
        cancelling: false,
      };
    case "failed":
      return {
        ...(prev ?? {
          destination: "",
          tracks: 0,
          stage: "plan",
          current: 0,
          total: 0,
          title: null,
          skipped: 0,
          warnings: [],
          cancelling: false,
        }),
        phase: "error",
        error: ev.error,
        cancelling: false,
      };
    default:
      return prev;
  }
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
