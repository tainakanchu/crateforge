// 曲行の長押しで開く共通アクションメニュー。各画面の TrackRow.onLongPress から呼ぶ。
// フック非依存（通常関数）なので getState() でストアにアクセスする。
// トリアージ系（評価・タグ・あとで聴く）はオンライン直書き / オフラインは pending キュー (#125)。

import { Alert } from "react-native";
import {
  ApiError,
  type Track,
  trackArtist,
  trackAlbumArtist,
  trackTitle,
  useConnection,
  usePlayer,
  useDownloads,
  useSettings,
} from "@crateforge/core";
import { router } from "expo-router";

import { COMMON_TRIAGE_TAGS, REVIEW_LATER_TAG } from "@/features/triage/commonTags";
import { usePendingEdits } from "@/store/pendingEdits";
import { startRadio } from "./radio";

/**
 * 曲ごとのアクションメニューを表示する。文脈（オンライン/アルバム有無/アーティスト名）で
 * ボタンを出し分ける。
 */
export function showTrackMenu(track: Track): void {
  const online = useConnection.getState().client != null;
  const grouping = useSettings.getState().artistGrouping;
  const artistName = grouping === "albumArtist" ? trackAlbumArtist(track) : trackArtist(track);

  const buttons: Parameters<typeof Alert.alert>[2] = [];

  // 似た曲でラジオ（オンラインのみ）。
  if (online) {
    buttons.push({ text: "似た曲でラジオ", onPress: () => void startRadio(track) });
  }

  // 次に再生。
  buttons.push({ text: "次に再生", onPress: () => usePlayer.getState().enqueueNext(track) });

  // --- トリアージ（評価 / タグ / あとで）---
  buttons.push({ text: "評価…", onPress: () => showRateMenu(track) });
  buttons.push({ text: "タグを付ける…", onPress: () => showTagMenu(track) });
  buttons.push({
    text: "あとで聴く",
    onPress: () => void applyReviewLater(track),
  });

  // アーティストを見る（表示名が "Unknown Artist"/空でなければ）。
  if (artistName && artistName !== "Unknown Artist") {
    buttons.push({
      text: "アーティストを見る",
      onPress: () => router.push(`/artist/${encodeURIComponent(artistName)}`),
    });
  }

  // アルバムを保存（オンライン かつ album があるとき）。
  if (online && track.album) {
    buttons.push({
      text: "アルバムを保存",
      onPress: () => void useDownloads.getState().downloadAlbum(track.album!),
    });
  }

  buttons.push({ text: "キャンセル", style: "cancel" });

  Alert.alert(track.name || "この曲", undefined, buttons);
}

/** ★1–5 / クリア のサブメニュー。 */
function showRateMenu(track: Track): void {
  const stars = [1, 2, 3, 4, 5].map((n) => ({
    text: "★".repeat(n),
    onPress: () => void applyRating(track, n * 20),
  }));
  Alert.alert("評価", trackTitle(track), [
    ...stars,
    { text: "クリア", style: "destructive", onPress: () => void applyRating(track, 0) },
    { text: "キャンセル", style: "cancel" },
  ]);
}

/** 定番タグのチップ相当メニュー。 */
function showTagMenu(track: Track): void {
  const buttons: Parameters<typeof Alert.alert>[2] = COMMON_TRIAGE_TAGS.map(({ tag, label }) => ({
    text: label,
    onPress: () => void applyTagAdd(track, tag),
  }));
  buttons.push({ text: "キャンセル", style: "cancel" });
  Alert.alert("タグを付ける", trackTitle(track), buttons);
}

async function applyRating(track: Track, rating: number): Promise<void> {
  const client = useConnection.getState().client;
  const baseRating = track.rating ?? null;
  if (client) {
    try {
      await client.setRating(track.id, rating);
    } catch (e) {
      Alert.alert("評価を保存できませんでした", errorMessage(e));
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
  Alert.alert("オフライン", "再接続時に評価を同期します");
}

async function applyTagAdd(track: Track, tag: string): Promise<void> {
  const client = useConnection.getState().client;
  if (client) {
    try {
      await client.addTrackTags([track.id], tag);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
        Alert.alert("タグ未対応", "ホストが first-class Tags に未対応です");
        return;
      }
      Alert.alert("タグを付けられませんでした", errorMessage(e));
    }
    return;
  }
  usePendingEdits.getState().enqueue({
    kind: "tag-add",
    trackId: track.id,
    tag,
    trackName: track.name,
  });
  Alert.alert("オフライン", "再接続時にタグを同期します");
}

async function applyReviewLater(track: Track): Promise<void> {
  const client = useConnection.getState().client;
  if (client) {
    try {
      await client.addTrackTags([track.id], REVIEW_LATER_TAG);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
        // タグ API 無しでもローカルフラグとしてキューへ。
        usePendingEdits.getState().enqueue({
          kind: "review-later",
          trackId: track.id,
          trackName: track.name,
        });
        Alert.alert("ローカルに記録", "ホスト未対応のため端末側のみ保持します");
        return;
      }
      Alert.alert("記録できませんでした", errorMessage(e));
    }
    return;
  }
  usePendingEdits.getState().enqueue({
    kind: "review-later",
    trackId: track.id,
    trackName: track.name,
  });
  Alert.alert("オフライン", "再接続時に「あとで聴く」を同期します");
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
