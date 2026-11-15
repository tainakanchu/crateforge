// 評価・タグ書き込みの「失敗」「デスクトップ未対応」をトーストで知らせる（3 経路共通）。
// プレイヤーの星 / 長押しメニュー / Now Playing のクイック操作は、失敗・未対応の文言と扱いを
// ここに揃える。成功・オフラインで積んだときの見せ方（トースト / 画面内の一言）は各画面が決める。

import { describeApiError } from "@crateforge/core";

import { showToast } from "@/components/Toast";
import { REVIEW_LATER_TAG } from "./commonTags";
import {
  type EditOutcome,
  type RatingEdit,
  type TagEdit,
  queueReviewLater,
  writeRating,
  writeTag,
} from "./edits";

/** 書き込みの結果。failed は失敗してトーストで知らせ済み。 */
export type EditResult = EditOutcome | "failed";

/** 評価を保存できなかったことを知らせる（理由は describeApiError）。 */
export function reportRatingFailure(e: unknown): void {
  showToast(`評価を保存できませんでした（${describeApiError(e)}）`, "error");
}

/** 評価を書く。失敗はトーストで知らせて "failed" を返す（投げない）。 */
export async function rateWithFeedback(edit: RatingEdit): Promise<EditResult> {
  try {
    return await writeRating(edit);
  } catch (e) {
    reportRatingFailure(e);
    return "failed";
  }
}

/**
 * タグを付ける（`review:later` =「あとで聴く」を含む）。失敗・未対応はここでトーストを出す。
 * - 失敗: 理由つきのエラートーストを出して "failed"。
 * - デスクトップがタグ未対応: エラートーストを出して "unsupported"。
 *   「あとで聴く」だけは端末側のキューに記録し、その旨を知らせる。
 * - applied / queued: 何も出さない（呼び出し側が見せる）。
 */
export async function addTagWithFeedback(edit: TagEdit): Promise<EditResult> {
  const reviewLater = edit.tag === REVIEW_LATER_TAG;
  try {
    const outcome = await writeTag(edit);
    if (outcome === "unsupported") {
      if (reviewLater) {
        queueReviewLater(edit);
        showToast("デスクトップ未対応のため、端末側のみに記録しました");
      } else {
        showToast("このデスクトップはタグ機能に未対応です（アプリを更新してください）", "error");
      }
    }
    return outcome;
  } catch (e) {
    const reason = describeApiError(e);
    showToast(
      reviewLater ? `記録できませんでした（${reason}）` : `タグを付けられませんでした（${reason}）`,
      "error",
    );
    return "failed";
  }
}
