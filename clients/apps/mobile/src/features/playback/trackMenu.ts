// 曲行の長押しで開く共通アクションメニュー。各画面の TrackRow.onLongPress から呼ぶ。
// フック非依存（通常関数）なので getState() でストアにアクセスする。

import { Alert } from "react-native";
import {
  type Track,
  trackArtist,
  trackAlbumArtist,
  useConnection,
  usePlayer,
  useDownloads,
  useSettings,
} from "@crateforge/core";
import { router } from "expo-router";

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
