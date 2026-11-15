// 曲行の長押しで開く共通アクションメニュー。各画面の TrackRow.onLongPress から呼ぶ。
// フック非依存（通常関数）なので getState() でストアにアクセスする。
// トリアージ系（評価・タグ・あとで聴く）はオンライン直書き / オフラインは pending キュー (#125)。

import {
  type Track,
  describeApiError,
  trackArtist,
  trackArtistKey,
  trackAlbumArtistKey,
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
import { albumHref, artistHref } from "@/lib/albumHref";

import { COMMON_TRIAGE_TAGS } from "@/features/triage/commonTags";
import {
  invalidateRatingQueries,
  queueReviewLater,
  writeRating,
  writeReviewLater,
  writeTag,
} from "@/features/triage/edits";
import { queryClient } from "@/lib/queryClient";
import { startRadio } from "./radio";
import { playTrackOnDesktop } from "./desktopPlay";

/**
 * 曲ごとのアクションメニューを表示する。文脈（オンライン/アルバム有無/アーティスト名）で
 * ボタンを出し分ける。
 */
export function showTrackMenu(track: Track): void {
  const online = useConnection.getState().client != null;
  const grouping = useSettings.getState().artistGrouping;
  // 束ねキー（タグにアーティストが無ければ ""）。
  const artistKey = grouping === "albumArtist" ? trackAlbumArtistKey(track) : trackArtistKey(track);

  const actions: ActionSheetAction[] = [];

  // 似た曲でラジオ（オンラインのみ）。
  if (online) {
    actions.push({ label: "似た曲でラジオ", onPress: () => void startRadio(track) });
  }

  // デスクトップ側で再生（オンラインのみ）。
  if (online) {
    // キューを黙って全置換しない（キューに曲があれば確認を出す）。
    actions.push({ label: "デスクトップで再生…", onPress: () => void playTrackOnDesktop(track) });
  }

  // 次に再生。
  actions.push({ label: "次に再生", onPress: () => usePlayer.getState().enqueueNext(track) });

  // --- トリアージ（評価 / タグ / あとで）---
  actions.push({ label: "評価…", onPress: () => showRateMenu(track) });
  actions.push({ label: "タグを付ける…", onPress: () => showTagMenu(track) });
  actions.push({ label: "あとで聴く", onPress: () => void applyReviewLater(track) });

  // アーティストを見る（タグにアーティストがあるときだけ。不明なアーティストは一覧から辿れる）。
  if (artistKey.trim()) {
    actions.push({
      label: "アーティストを見る",
      onPress: () => router.push(artistHref(artistKey)),
    });
  }

  // アルバムを見る（album 名があれば。アルバム詳細はオフラインでも DL 済みの曲を出せる。round-3 N4）。
  const albumName = track.album?.trim() ? track.album : null;
  if (albumName) {
    actions.push({ label: "アルバムを見る", onPress: () => router.push(albumHref(albumName)) });
  }

  // アルバムを保存（オンライン かつ album があるとき）。
  if (online && track.album) {
    actions.push({
      label: "アルバムを保存",
      onPress: () => void useDownloads.getState().downloadAlbum(track.album!),
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
  try {
    const outcome = await writeRating({
      trackId: track.id,
      rating,
      baseRating: track.rating ?? null,
      trackName: track.name,
    });
    if (outcome === "queued") {
      showToast("オフライン: 再接続時に評価を同期します");
    } else {
      showToast(rating > 0 ? `評価を保存しました（${formatRatingStars(rating)}）` : "評価をクリアしました");
    }
  } catch (e) {
    showToast(`評価を保存できませんでした（${errorMessage(e)}）`, "error");
  } finally {
    // プレイヤーの星（useSetRating）と同じく、成功/失敗どちらでも rating を含む一覧を取り直す
    // （しないと、開いている一覧の星や評価順が古いまま残る）。
    void invalidateRatingQueries(queryClient);
  }
}

async function applyTagAdd(track: Track, tag: string): Promise<void> {
  try {
    const outcome = await writeTag({ trackId: track.id, tag, trackName: track.name });
    if (outcome === "unsupported") {
      showToast("このデスクトップはタグ機能に未対応です（アプリを更新してください）", "error");
    } else if (outcome === "queued") {
      showToast("オフライン: 再接続時にタグを同期します");
    } else {
      showToast("タグを付けました");
    }
  } catch (e) {
    showToast(`タグを付けられませんでした（${errorMessage(e)}）`, "error");
  }
}

async function applyReviewLater(track: Track): Promise<void> {
  const edit = { trackId: track.id, trackName: track.name };
  try {
    const outcome = await writeReviewLater(edit);
    if (outcome === "unsupported") {
      // タグ API 無しでもローカルフラグとしてキューへ。
      queueReviewLater(edit);
      showToast("デスクトップ未対応のため、端末側のみに記録しました");
    } else if (outcome === "queued") {
      showToast("オフライン: 再接続時に「あとで聴く」を同期します");
    } else {
      showToast("「あとで聴く」に追加しました");
    }
  } catch (e) {
    showToast(`記録できませんでした（${errorMessage(e)}）`, "error");
  }
}

// API の生本文（{"error":...} / "HTTP 500"）を出さず、日本語の理由にする（round-3 N7）。
function errorMessage(e: unknown): string {
  return describeApiError(e);
}
