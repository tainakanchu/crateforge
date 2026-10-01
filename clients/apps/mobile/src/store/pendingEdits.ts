// オフライン中のレーティング / タグ編集キュー（zustand + SecureStore 永続化）。
// 接続復帰時に flushPending でホストへ書き戻し、真の衝突は conflicts に残す。

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const KEY_OPS = "crateforge.pendingEdits";
const KEY_CONFLICTS = "crateforge.pendingEditConflicts";

/** キューに載せる編集オペレーション。 */
export type PendingOp =
  | {
      id: string;
      kind: "rating";
      trackId: number;
      rating: number;
      baseRating: number | null;
      trackName?: string | null;
      createdAt: string;
    }
  | {
      id: string;
      kind: "tag-add";
      trackId: number;
      tag: string;
      trackName?: string | null;
      createdAt: string;
    }
  | {
      id: string;
      kind: "tag-remove";
      trackId: number;
      tag: string;
      trackName?: string | null;
      createdAt: string;
    }
  | {
      id: string;
      kind: "review-later";
      trackId: number;
      trackName?: string | null;
      createdAt: string;
    };

/** サーバ側と衝突した rating op（黙って上書きしない）。 */
export type EditConflict = {
  id: string;
  op: Extract<PendingOp, { kind: "rating" }>;
  /** 衝突検出時点のサーバ rating。 */
  serverRating: number | null;
  detectedAt: string;
};

export type PendingOpInput =
  | Omit<Extract<PendingOp, { kind: "rating" }>, "id" | "createdAt">
  | Omit<Extract<PendingOp, { kind: "tag-add" }>, "id" | "createdAt">
  | Omit<Extract<PendingOp, { kind: "tag-remove" }>, "id" | "createdAt">
  | Omit<Extract<PendingOp, { kind: "review-later" }>, "id" | "createdAt">;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function persistOps(ops: PendingOp[]): void {
  void SecureStore.setItemAsync(KEY_OPS, JSON.stringify(ops)).catch(() => {});
}

function persistConflicts(conflicts: EditConflict[]): void {
  void SecureStore.setItemAsync(KEY_CONFLICTS, JSON.stringify(conflicts)).catch(() => {});
}

function parseOps(raw: string | null): PendingOp[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingOp);
  } catch {
    return [];
  }
}

function parseConflicts(raw: string | null): EditConflict[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEditConflict);
  } catch {
    return [];
  }
}

function isPendingOp(v: unknown): v is PendingOp {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.kind !== "string" || typeof o.trackId !== "number") {
    return false;
  }
  if (o.kind === "rating") {
    return typeof o.rating === "number";
  }
  if (o.kind === "tag-add" || o.kind === "tag-remove") {
    return typeof o.tag === "string";
  }
  if (o.kind === "review-later") return true;
  return false;
}

function isEditConflict(v: unknown): v is EditConflict {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && isPendingOp(o.op) && (o.op as PendingOp).kind === "rating";
}

export interface PendingEditsState {
  ops: PendingOp[];
  conflicts: EditConflict[];
  /** flush 実行中フラグ（再入防止）。 */
  flushing: boolean;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  /** キューに追加。同一 track の rating は最新で置き換える。 */
  enqueue: (input: PendingOpInput) => PendingOp;
  remove: (id: string) => void;
  clearOps: () => void;

  /** 衝突として記録し、対応する pending op をキューから外す。 */
  markConflict: (op: Extract<PendingOp, { kind: "rating" }>, serverRating: number | null) => void;
  /** 衝突を破棄（サーバ側を採用）。 */
  dismissConflict: (id: string) => void;
  /** 衝突を解決済みとして削除（Keep mine 適用後など）。 */
  resolveConflict: (id: string) => void;
  setFlushing: (v: boolean) => void;
}

export const usePendingEdits = create<PendingEditsState>((set, get) => ({
  ops: [],
  conflicts: [],
  flushing: false,
  hydrated: false,

  hydrate: async () => {
    try {
      const [opsRaw, conflictsRaw] = await Promise.all([
        SecureStore.getItemAsync(KEY_OPS),
        SecureStore.getItemAsync(KEY_CONFLICTS),
      ]);
      set({
        ops: parseOps(opsRaw),
        conflicts: parseConflicts(conflictsRaw),
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  enqueue: (input) => {
    const op = {
      ...input,
      id: newId(),
      createdAt: new Date().toISOString(),
    } as PendingOp;

    set((state) => {
      let next = state.ops;
      // 同一曲の rating は最新 1 件にまとめる（古い base を捨てる）。
      if (op.kind === "rating") {
        next = next.filter((o) => !(o.kind === "rating" && o.trackId === op.trackId));
        // 未解決の衝突も新しい編集で上書きする意図なら衝突側も落とす。
        const conflicts = state.conflicts.filter((c) => c.op.trackId !== op.trackId);
        if (conflicts.length !== state.conflicts.length) {
          persistConflicts(conflicts);
          // set は一度にまとめるため下で ops と一緒に返す。
          const ops = [...next, op];
          persistOps(ops);
          return { ops, conflicts };
        }
      }
      // 同一曲・同一タグの add/remove は最新で置き換え。
      if (op.kind === "tag-add" || op.kind === "tag-remove") {
        next = next.filter(
          (o) =>
            !(
              (o.kind === "tag-add" || o.kind === "tag-remove") &&
              o.trackId === op.trackId &&
              o.tag === op.tag
            ),
        );
      }
      // review-later は曲ごとに 1 件。
      if (op.kind === "review-later") {
        next = next.filter((o) => !(o.kind === "review-later" && o.trackId === op.trackId));
      }
      const ops = [...next, op];
      persistOps(ops);
      return { ops };
    });

    return op;
  },

  remove: (id) => {
    set((state) => {
      const ops = state.ops.filter((o) => o.id !== id);
      persistOps(ops);
      return { ops };
    });
  },

  clearOps: () => {
    persistOps([]);
    set({ ops: [] });
  },

  markConflict: (op, serverRating) => {
    set((state) => {
      const ops = state.ops.filter((o) => o.id !== op.id);
      const conflicts = [
        ...state.conflicts.filter((c) => c.op.trackId !== op.trackId),
        {
          id: op.id,
          op,
          serverRating,
          detectedAt: new Date().toISOString(),
        },
      ];
      persistOps(ops);
      persistConflicts(conflicts);
      return { ops, conflicts };
    });
  },

  dismissConflict: (id) => {
    set((state) => {
      const conflicts = state.conflicts.filter((c) => c.id !== id);
      persistConflicts(conflicts);
      return { conflicts };
    });
  },

  resolveConflict: (id) => {
    get().dismissConflict(id);
  },

  setFlushing: (v) => set({ flushing: v }),
}));

/** キュー + 衝突の件数サマリ（Settings バナー用）。 */
export function pendingSummary(state: Pick<PendingEditsState, "ops" | "conflicts">): {
  pending: number;
  conflicts: number;
} {
  return { pending: state.ops.length, conflicts: state.conflicts.length };
}
