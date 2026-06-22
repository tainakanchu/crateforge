// 再生エラーの通知（描画なしの購読コンポーネント）。
// プレイヤーストアの lastError を監視し、新しいエラーが出たら
// Android では Toast、iOS では控えめな Alert で知らせて即 clearError する。
// player.ts（@crateforge/core）はプラットフォーム非依存に保ちたいので、
// 実際の通知表示はこのモバイル側コンポーネントが担当する。

import { useEffect, useRef } from "react";
import { Platform, ToastAndroid, Alert } from "react-native";

import { usePlayer } from "@crateforge/core";

export default function PlaybackErrorToast() {
  const lastError = usePlayer((s) => s.lastError);
  const clearError = usePlayer((s) => s.clearError);
  // 同じエラーオブジェクトで二重発火しないよう、処理済みの at を覚えておく。
  const handledAt = useRef<number | null>(null);

  useEffect(() => {
    if (!lastError) return;
    if (handledAt.current === lastError.at) return;
    handledAt.current = lastError.at;

    if (Platform.OS === "android") {
      ToastAndroid.show(lastError.message, ToastAndroid.SHORT);
    } else {
      // iOS には Toast が無いので、ブロッキングの少ない簡易 Alert で代替する。
      Alert.alert("再生エラー", lastError.message);
    }
    // 表示したので消費する（次の同文言エラーも at が変わるので再通知できる）。
    clearError();
  }, [lastError, clearError]);

  return null;
}
