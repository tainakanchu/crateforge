import { create } from "zustand";
import * as libraryApi from "../api/library";
import type { ImportActionItem, ImportActionsSummary, ImportPlanItem } from "../types";
import { defaultDecision, type DuplicateDecision } from "./duplicates";

/**
 * 計画 1 件の既定の扱い。取り込む側のファイルが破損の疑いなら既定でスキップ
 * (壊れたファイルで既存曲を置き換えたり、壊れた曲を増やしたりしない)。
 */
export function planDefaultDecision(p: ImportPlanItem): DuplicateDecision {
  if (p.sourceBroken) return { action: "skip", replaceTrackId: null };
  return defaultDecision(p.hits);
}

/**
 * ファイル / フォルダ取り込み (メニュー・ドラッグ&ドロップ共通) の流れ:
 *
 * 1. `plan_import` でタグを読み、ライブラリの既存曲と照合する。
 * 2. 別ファイルとして取り込み済みの曲が無ければ、そのまま取り込む
 *    (同じパスの曲は従来どおり黙ってスキップ)。
 * 3. あれば ImportDuplicatesDialog で曲ごとの扱い (取り込む / スキップ / 置き換え) を
 *    選んでもらい、`import_with_actions` で取り込む。
 */

interface PendingDuplicates {
  items: ImportPlanItem[];
  /** ダイアログに出さずそのまま取り込む曲の数 (「ほかの N 曲はそのまま取り込みます」)。 */
  otherCount: number;
  resolve: (decisions: Map<string, DuplicateDecision> | null) => void;
}

/** ImportDuplicatesDialog の表示状態 (App に 1 つだけマウントする)。 */
export const useImportDuplicates = create<{ pending: PendingDuplicates | null }>(() => ({
  pending: null,
}));

function askDuplicates(
  items: ImportPlanItem[],
  otherCount: number,
): Promise<Map<string, DuplicateDecision> | null> {
  return new Promise((resolve) => {
    // 前の確認が残っていたらキャンセル扱いで閉じる。
    useImportDuplicates.getState().pending?.resolve(null);
    useImportDuplicates.setState({
      pending: {
        items,
        otherCount,
        resolve: (d) => {
          useImportDuplicates.setState({ pending: null });
          resolve(d);
        },
      },
    });
  });
}

/** 空状態などツールバー以外から取り込みを始めるときの種類。 */
export type ImportRequestKind = "folder" | "files" | "xml";

let importHandler: ((kind: ImportRequestKind) => void) | null = null;

/**
 * 取り込みの実処理 (ダイアログ・進捗表示) を持つコンポーネント (Toolbar) が登録する。
 * 戻り値で登録を解除する。
 */
export function registerImportHandler(h: (kind: ImportRequestKind) => void): () => void {
  importHandler = h;
  return () => {
    if (importHandler === h) importHandler = null;
  };
}

/** 空状態のボタンなどから取り込みを要求する (Toolbar と同じ処理が走る)。 */
export function requestImport(kind: ImportRequestKind): void {
  importHandler?.(kind);
}

export interface ImportFlowCallbacks {
  /** 照合中・取り込み中の進捗表示 (任意)。 */
  onStatus?: (msg: string) => void;
}

/**
 * 取り込み済み検出つきで取り込む。キャンセルされたら null。
 * 対応ファイルが 1 つも無ければ全件 0 の結果を返す。
 */
export async function importWithDuplicateCheck(
  paths: string[],
  cb: ImportFlowCallbacks = {},
): Promise<ImportActionsSummary | null> {
  const unlistenPlan = await libraryApi.onImportPlanProgress(({ done, total }) => {
    cb.onStatus?.(total > 0 ? `照合中 ${done}/${total}` : "対応ファイルなし");
  });
  let plan: ImportPlanItem[];
  try {
    plan = await libraryApi.planImport(paths);
  } finally {
    unlistenPlan();
  }
  if (plan.length === 0) {
    return { imported: 0, skipped: 0, replaced: 0, failed: 0, results: [] };
  }

  // 確認が要るもの: 取り込み済みの一致がある / 取り込む側のファイルが破損の疑い。
  const needsDecision = (p: ImportPlanItem) =>
    !p.alreadyImportedSamePath && (p.hits.length > 0 || p.sourceBroken);
  // 表記の違う同じファイル (別名のリンク / ハードリンク) は、確認を出すときは
  // 「登録済み（同じファイル）」の行として並べ、ダイアログの件数と取り込み結果を合わせる (E1)。
  // 文字列として同じパスの曲は従来どおり黙ってスキップする。
  const linkedSame = (p: ImportPlanItem) => p.alreadyImportedSamePath && !!p.registeredPath;
  let decisions: Map<string, DuplicateDecision> | null = new Map();
  if (plan.some(needsDecision)) {
    const shown = plan.filter((p) => needsDecision(p) || linkedSame(p));
    const otherCount = plan.filter((p) => !p.alreadyImportedSamePath && !needsDecision(p)).length;
    decisions = await askDuplicates(shown, otherCount);
    if (!decisions) return null;
  }

  const items: ImportActionItem[] = plan.map((p) => {
    if (p.alreadyImportedSamePath) return { path: p.path, action: "skip" };
    const d = decisions.get(p.path) ?? planDefaultDecision(p);
    return { path: p.path, action: d.action, replaceTrackId: d.replaceTrackId };
  });

  const unlisten = await libraryApi.onImportProgress(({ done, total }) => {
    cb.onStatus?.(total > 0 ? `取り込み中 ${done}/${total}` : "対応ファイルなし");
  });
  try {
    return await libraryApi.importWithActions(items);
  } finally {
    unlisten();
  }
}

/** トースト用の結果サマリ ("取り込み N / スキップ N / 置き換え N / 失敗 N")。 */
export function summarizeImport(r: ImportActionsSummary): string {
  return `取り込み ${r.imported} / スキップ ${r.skipped} / 置き換え ${r.replaced} / 失敗 ${r.failed}`;
}
