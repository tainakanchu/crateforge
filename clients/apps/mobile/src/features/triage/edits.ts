// 評価・タグの書き込み（UI 非依存）。プレイヤーの星 / 長押しメニュー / Now Playing のクイック操作が
// 同じ手順を通る: オンラインならデスクトップへ直書き、オフラインなら pending キュー (#125)。
// 失敗・未対応の知らせ方は feedback.ts（3 経路共通のトースト）。成功時の見せ方は呼び出し側が決める。

import type { QueryClient } from "@tanstack/react-query";

import { ApiError, browseKeys, useConnection } from "@crateforge/core";

import { usePendingEdits } from "@/store/pendingEdits";
import { REVIEW_LATER_TAG } from "./commonTags";

/**
 * 書き込みの結果。
 * - applied: デスクトップへ書き込んだ。
 * - queued: オフラインのため pending キューに積んだ（再接続時に同期）。
 * - unsupported: デスクトップがタグ API に未対応（404 / 501）。何も書いていない。
 * それ以外の失敗は例外のまま投げる（文言は呼び出し側で describeApiError）。
 */
export type EditOutcome = "applied" | "queued" | "unsupported";

export interface RatingEdit {
  /** DB の track id（Track.id）。 */
  trackId: number;
  /** 0..100。ApiClient.setRating が clamp する。 */
  rating: number;
  /** 編集開始時に見ていた rating（再接続時の衝突検知用）。 */
  baseRating?: number | null;
  trackName?: string | null;
}

export interface TagEdit {
  /** DB の track id（Track.id）。 */
  trackId: number;
  tag: string;
  trackName?: string | null;
}

export type ReviewLaterEdit = Omit<TagEdit, "tag">;

/** rating を含むキャッシュ済みクエリのキープレフィックス（無効化対象）。 */
export const RATING_AFFECTED_KEYS = [
  browseKeys.tracksRoot,
  browseKeys.artistTracksRoot,
  browseKeys.albumTracksRoot,
  browseKeys.playlistTracksRoot,
  browseKeys.similarRoot,
] as const;

/** rating を含む可能性のある一覧を無効化して取り直させる（評価の書き込み後に呼ぶ）。 */
export async function invalidateRatingQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    RATING_AFFECTED_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: key })),
  );
}

/** 評価を書く。オンラインは直書き（失敗は throw）、オフラインはキューへ。 */
export async function writeRating(edit: RatingEdit): Promise<EditOutcome> {
  const client = useConnection.getState().client;
  if (client) {
    await client.setRating(edit.trackId, edit.rating);
    return "applied";
  }
  // オフライン: キューへ。再接続時に baseRating と突き合わせて衝突検知する。
  usePendingEdits.getState().enqueue({
    kind: "rating",
    trackId: edit.trackId,
    rating: edit.rating,
    baseRating: edit.baseRating ?? null,
    trackName: edit.trackName ?? null,
  });
  return "queued";
}

/**
 * first-class Tag を付ける。オフラインは tag-add としてキューへ。
 * `review:later`（あとで聴く）だけは、どの経路から来ても専用の review-later としてキューに積む
 * （同期時はどちらも同じ `review:later` タグの追加になる。保留一覧の表示を「あとで」に揃えるため）。
 */
export function writeTag(edit: TagEdit): Promise<EditOutcome> {
  return addTagOrQueue(edit.trackId, edit.tag, () => {
    if (edit.tag === REVIEW_LATER_TAG) {
      queueReviewLater(edit);
      return;
    }
    usePendingEdits.getState().enqueue({
      kind: "tag-add",
      trackId: edit.trackId,
      tag: edit.tag,
      trackName: edit.trackName ?? null,
    });
  });
}

/** 「あとで聴く」(`review:later` タグ) を付ける。writeTag に review:later を渡すのと同じ。 */
export function writeReviewLater(edit: ReviewLaterEdit): Promise<EditOutcome> {
  return writeTag({ ...edit, tag: REVIEW_LATER_TAG });
}

/** 「あとで聴く」を端末側のキューにだけ記録する（デスクトップがタグ未対応のときの退避にも使う）。 */
export function queueReviewLater(edit: ReviewLaterEdit): void {
  usePendingEdits.getState().enqueue({
    kind: "review-later",
    trackId: edit.trackId,
    trackName: edit.trackName ?? null,
  });
}

async function addTagOrQueue(trackId: number, tag: string, enqueue: () => void): Promise<EditOutcome> {
  const client = useConnection.getState().client;
  if (!client) {
    enqueue();
    return "queued";
  }
  try {
    await client.addTrackTags([trackId], tag);
    return "applied";
  } catch (e) {
    // 古いホスト: タグ API 無し。
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return "unsupported";
    throw e;
  }
}
