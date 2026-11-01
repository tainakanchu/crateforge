// 再生バックエンドの選択（起動時に 1 回）。
// - Android かつ expo-crateforge-android-auto が使える（= GitHub 配布 APK / 対応 dev client）:
//   キューと再生の正本をネイティブ（Media3）へ移す。expo-audio の Player/MediaSession は作らない
//   （通知・音声を 1 系統に保つ）。
// - それ以外（iOS / Expo Go / モジュール未同梱の旧 dev client）: 従来どおり ExpoAudioEngine。
// TV アプリはこのファイルを使わない（TV は常に ExpoAudioEngine）。

import { Platform } from "react-native";
import * as AndroidAuto from "expo-crateforge-android-auto";

import { createAudioEngine, initPlayback, usePlayer } from "@crateforge/core";
import {
  installAndroidNativePlayback,
  notifyNativeDownloadsChanged,
  type AndroidNativePlayback,
} from "./androidNativePlayback";

export type PlaybackMode = "native" | "expo-audio";

let mode: PlaybackMode | null = null;
let native: AndroidNativePlayback | null = null;

function setupExpoAudio(): PlaybackMode {
  usePlayer.getState().setEngine(createAudioEngine());
  void initPlayback();
  return "expo-audio";
}

/**
 * 再生バックエンドを差し込む。hydrate 群より前に呼ぶこと。
 * 2 回目以降は何もせず最初に選んだモードを返す（StrictMode の effect 二重実行対策）。
 */
export function setupPlayback(): PlaybackMode {
  if (mode != null) return mode;
  if (Platform.OS === "android" && AndroidAuto.isAvailable()) {
    try {
      native = installAndroidNativePlayback();
      mode = "native";
      return mode;
    } catch (e) {
      // ネイティブ側の初期化に失敗しても再生できないよりはマシなので JS 経路へ退避する。
      console.warn("[playback] native backend unavailable, falling back to expo-audio:", e);
      native = null;
    }
  }
  mode = setupExpoAudio();
  return mode;
}

/** 現在の再生モード（setupPlayback 前は null）。 */
export function getPlaybackMode(): PlaybackMode | null {
  return mode;
}

/**
 * ダウンロード（index.json / playlists.json）の読み込み完了後に呼ぶ。
 * ネイティブモードではカタログへ 1 回取り込みを促す（以後の変更は persist リスナーが通知）。
 */
export function onDownloadsHydrated(): void {
  if (mode === "native") notifyNativeDownloadsChanged();
}

/** テスト用：選択状態を初期化する（ネイティブの配線も外す）。 */
export function resetPlaybackSetupForTests(): void {
  native?.dispose();
  native = null;
  mode = null;
}
