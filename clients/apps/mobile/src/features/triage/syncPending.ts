// pendingEdits をホストへ書き戻す同期エンジン。
// レーティングは base スナップショットとの衝突を検知し、真の衝突は黙って上書きしない。
// タグは集合マージ（add/remove）なのでそのまま適用。ホスト未対応 (404) は degrade。

import { ApiError, type ApiClient } from "@crateforge/core";

import { resolveRatingConflict } from "./conflict";
import { usePendingEdits, type PendingOp } from "@/store/pendingEdits";

export type FlushResult = {
  applied: number;
  conflicts: number;
  failed: number;
  skippedUnsupported: number;
};

/**
 * キューを先頭から処理する。ネットワーク切断や連続失敗で打ち切り、残りは次回へ。
 * 再入防止: flushing 中は no-op。
 */
export async function flushPending(client: ApiClient): Promise<FlushResult> {
  const store = usePendingEdits.getState();
  if (store.flushing) {
    return { applied: 0, conflicts: 0, failed: 0, skippedUnsupported: 0 };
  }
  store.setFlushing(true);

  let applied = 0;
  let conflicts = 0;
  let failed = 0;
  let skippedUnsupported = 0;

  try {
    // スナップショットを取り、ループ中の enqueue と干渉しない。
    const snapshot = [...usePendingEdits.getState().ops];
    for (const op of snapshot) {
      // 途中で remove されていたらスキップ。
      if (!usePendingEdits.getState().ops.some((o) => o.id === op.id)) continue;

      try {
        const outcome = await applyOne(client, op);
        if (outcome === "applied") {
          usePendingEdits.getState().remove(op.id);
          applied += 1;
        } else if (outcome === "conflict" && op.kind === "rating") {
          // markConflict は ops から外す。
          // serverRating は applyOne 内で mark 済みの場合もあるが、ここで統一する。
          // applyOne が conflict を返すとき既に mark している。
          conflicts += 1;
        } else if (outcome === "unsupported") {
          usePendingEdits.getState().remove(op.id);
          skippedUnsupported += 1;
        }
      } catch {
        failed += 1;
        // ネットワーク等: 残りを次回に回すため打ち切る。
        break;
      }
    }
  } finally {
    usePendingEdits.getState().setFlushing(false);
  }

  return { applied, conflicts, failed, skippedUnsupported };
}

type ApplyOutcome = "applied" | "conflict" | "unsupported";

async function applyOne(client: ApiClient, op: PendingOp): Promise<ApplyOutcome> {
  if (op.kind === "rating") {
    let current: number | null = null;
    try {
      const track = await client.getTrack(op.trackId);
      current = track.rating ?? null;
    } catch (e) {
      // 404 曲不明は捨てる。その他は再試行のため throw。
      if (e instanceof ApiError && e.status === 404) return "applied";
      throw e;
    }

    const decision = resolveRatingConflict(current, op.baseRating, op.rating);
    if (decision === "conflict") {
      usePendingEdits.getState().markConflict(op, current);
      return "conflict";
    }

    // current === op.rating でも setRating は冪等。呼び出しを省略してもよいが明示適用。
    if (current !== op.rating) {
      await client.setRating(op.trackId, op.rating);
    }
    return "applied";
  }

  if (op.kind === "tag-add") {
    return applyTagWrite(client, () => client.addTrackTags([op.trackId], op.tag));
  }

  if (op.kind === "tag-remove") {
    return applyTagWrite(client, () => client.removeTrackTags([op.trackId], op.tag));
  }

  // review-later → first-class tag `review:later` として書き戻す。
  if (op.kind === "review-later") {
    return applyTagWrite(client, () => client.addTrackTags([op.trackId], "review:later"));
  }

  return "applied";
}

async function applyTagWrite(
  _client: ApiClient,
  write: () => Promise<unknown>,
): Promise<ApplyOutcome> {
  try {
    await write();
    return "applied";
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
      // 古いホスト: タグ API 無し → 諦めてキューから落とす。
      return "unsupported";
    }
    // 403 等は保持して再試行（権限/ロール変更待ち）。
    throw e;
  }
}

/**
 * 衝突で「端末の値を採用」。setRating 後に conflict を消す。
 */
export async function keepMine(client: ApiClient, conflictId: string): Promise<boolean> {
  const conflict = usePendingEdits.getState().conflicts.find((c) => c.id === conflictId);
  if (!conflict) return false;
  try {
    await client.setRating(conflict.op.trackId, conflict.op.rating);
    usePendingEdits.getState().resolveConflict(conflictId);
    return true;
  } catch {
    return false;
  }
}

/** 衝突で「サーバを採用」。op を捨てるだけ。 */
export function keepServer(conflictId: string): void {
  usePendingEdits.getState().dismissConflict(conflictId);
}
