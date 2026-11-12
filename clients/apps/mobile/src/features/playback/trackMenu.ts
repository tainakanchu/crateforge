// 曲行の長押しで開く共通アクションメニュー。各画面の TrackRow.onLongPress から呼ぶ。
// フック非依存（通常関数）なので getState() でストアにアクセスする。
// トリアージ系（評価・タグ・あとで聴く）はオンライン直書き / オフラインは pending キュー (#125)。

import {
  ApiError,
  type Track,
  trackArtist,
  trackAlbumArtist,
  ratingToHalfStars,
  formatRatingStars,
  trackTitle,
  useConnection,
  usePlayer,
  useDownloads,
  useSettings,
} from "@crateforge/core";
import { router } from "expo-router";

import { type ActionSheetAction, showActionSheet } from "@/components/ActionSheet";
import { showToast } from "@/components/Toast";

import { COMMON_TRIAGE_TAGS, REVIEW_LATER_TAG } from "@/features/triage/commonTags";
import { usePendingEdits } from "@/store/pendingEdits";
import { startRadio } from "./radio";
import { playOnDesktop } from "./desktopPlay";

/**
 * 曲ごとのアクションメニューを表示する。文脈（オンライン/アルバム有無/アーティスト名）で
 * ボタンを出し分ける。
 */
export function showTrackMenu(track: Track): void {
  const online = useConnection.getState().client != null;
  const grouping = useSettings.getState().artistGrouping;
  const artistName = grouping === "albumArtist" ? trackAlbumArtist(track) : trackArtist(track);

  const actions: ActionSheetAction[] = [];

  // 似た曲でラジオ（オンラインのみ）。
  if (online) {
    actions.push({ label: "似た曲でラジオ", onPress: () => void startRadio(track) });
  }

  // デスクトップ側で再生（オンラインのみ）。
  if (online) {
    actions.push({ label: "デスクトップで再生", onPress: () => void playOnDesktop([track], 0) });
  }

  // 次に再生。
  actions.push({ label: "次に再生", onPress: () => usePlayer.getState().enqueueNext(track) });

  // --- トリアージ（評価 / タグ / あとで）---
  actions.push({ label: "評価…", onPress: () => showRateMenu(track) });
  actions.push({ label: "タグを付ける…", onPress: () => showTagMenu(track) });
  actions.push({ label: "あとで聴く", onPress: () => void applyReviewLater(track) });

  // アーティストを見る（表示名が "Unknown Artist"/空でなければ）。
  if (artistName && artistName !== "Unknown Artist") {
    actions.push({
      label: "アーティストを見る",
      onPress: () => router.push(`/artist/${encodeURIComponent(artistName)}`),
    });
  }

  // アルバムを保存（オンライン かつ album があるとき）。
  if (online && track.album) {
    actions.push({
      label: "アルバムを保存",
      onPress: () => void useDownloads.getState().downloadAlbum(track.album!, track.albumArtist),
    });
  }

  showActionSheet({ title: track.name || "この曲", subtitle: trackArtist(track), actions });
}

/** 評価（★0.5–5 / クリア）のサブメニュー。半星（10 刻み）対応。 */
export function showRateMenu(track: Track): void {
  const current = ratingToHalfStars(track.rating);
  const actions: ActionSheetAction[] = [];
  for (let half = 1; half <= 10; half++) {
    const stars = half / 2;
    actions.push({
      label: formatRatingStars(half * 10),
      detail: String(stars),
      selected: current === stars,
      onPress: () => void applyRating(track, half * 10),
    });
  }
  actions.push({ label: "クリア", destructive: true, onPress: () => void applyRating(track, 0) });
  showActionSheet({ title: "評価", subtitle: trackTitle(track), actions });
}

/** 定番タグのチップ相当メニュー。 */
function showTagMenu(track: Track): void {
  const actions: ActionSheetAction[] = COMMON_TRIAGE_TAGS.map(({ tag, label }) => ({
    label,
    onPress: () => void applyTagAdd(track, tag),
  }));
  showActionSheet({ title: "タグを付ける", subtitle: trackTitle(track), actions });
}

async function applyRating(track: Track, rating: number): Promise<void> {
  const client = useConnection.getState().client;
  const baseRating = track.rating ?? null;
  if (client) {
    try {
      await client.setRating(track.id, rating);
      showToast(rating > 0 ? `評価を保存しました（${formatRatingStars(rating)}）` : "評価をクリアしました");
    } catch (e) {
      showToast(`評価を保存できませんでした（${errorMessage(e)}）`, "error");
    }
    return;
  }
  usePendingEdits.getState().enqueue({
    kind: "rating",
    trackId: track.id,
    rating,
    baseRating,
    trackName: track.name,
  });
  showToast("オフライン: 再接続時に評価を同期します");
}

async function applyTagAdd(track: Track, tag: string): Promise<void> {
  const client = useConnection.getState().client;
  if (client) {
    try {
      await client.addTrackTags([track.id], tag);
      showToast("タグを付けました");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
        showToast("このデスクトップはタグ機能に未対応です（アプリを更新してください）", "error");
        return;
      }
      showToast(`タグを付けられませんでした（${errorMessage(e)}）`, "error");
    }
    return;
  }
  usePendingEdits.getState().enqueue({
    kind: "tag-add",
    trackId: track.id,
    tag,
    trackName: track.name,
  });
  showToast("オフライン: 再接続時にタグを同期します");
}

async function applyReviewLater(track: Track): Promise<void> {
  const client = useConnection.getState().client;
  if (client) {
    try {
      await client.addTrackTags([track.id], REVIEW_LATER_TAG);
      showToast("「あとで聴く」に追加しました");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
        // タグ API 無しでもローカルフラグとしてキューへ。
        usePendingEdits.getState().enqueue({
          kind: "review-later",
          trackId: track.id,
          trackName: track.name,
        });
        showToast("デスクトップ未対応のため、端末側のみに記録しました");
        return;
      }
      showToast(`記録できませんでした（${errorMessage(e)}）`, "error");
    }
    return;
  }
  usePendingEdits.getState().enqueue({
    kind: "review-later",
    trackId: track.id,
    trackName: track.name,
  });
  showToast("オフライン: 再接続時に「あとで聴く」を同期します");
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
