// 再生エラーの通知（描画なしの購読コンポーネント）。
// プレイヤーストアの lastError を監視し、新しいエラーが出たら
// Android では Toast、iOS では控えめな Alert で知らせて即 clearError する。
// player.ts（@crateforge/core）はプラットフォーム非依存に保ちたいので、
// 実際の通知表示はこのモバイル側コンポーネントが担当する。
// Android ネイティブ再生のエラーは code 付きで届く。端末非対応形式（UNSUPPORTED_FORMAT）のときは
// ダウンロード画面の「AAC で再ダウンロード」へ案内する（救済導線）。

import { useEffect, useRef } from "react";
import { Platform, ToastAndroid, Alert } from "react-native";

import { usePlayer } from "@crateforge/core";

/** 端末非対応形式のときに添える案内文。 */
export const UNSUPPORTED_FORMAT_HINT =
  "ダウンロード画面の「AAC で再ダウンロード」で再生できる形式に保存し直せます";

/** lastError から表示文言を作る（code に応じて案内を添える）。 */
export function playbackErrorText(error: { message: string; code?: string }): string {
  if (error.code === "UNSUPPORTED_FORMAT") return `${error.message}\n${UNSUPPORTED_FORMAT_HINT}`;
  return error.message;
}

export default function PlaybackErrorToast() {
  const lastError = usePlayer((s) => s.lastError);
  const clearError = usePlayer((s) => s.clearError);
  // 同じエラーオブジェクトで二重発火しないよう、処理済みの at を覚えておく。
  const handledAt = useRef<number | null>(null);

  useEffect(() => {
    if (!lastError) return;
    if (handledAt.current === lastError.at) return;
    handledAt.current = lastError.at;

    const text = playbackErrorText(lastError);
    if (Platform.OS === "android") {
      // 案内付きは読み切れるよう長めに出す。
      ToastAndroid.show(text, text === lastError.message ? ToastAndroid.SHORT : ToastAndroid.LONG);
    } else {
      // iOS には Toast が無いので、ブロッキングの少ない簡易 Alert で代替する。
      Alert.alert("再生エラー", text);
    }
    // 表示したので消費する（次の同文言エラーも at が変わるので再通知できる）。
    clearError();
  }, [lastError, clearError]);

  return null;
}
