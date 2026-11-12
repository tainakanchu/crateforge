// 再生エラーの通知（描画なしの購読コンポーネント）。
// プレイヤーストアの lastError を監視し、新しいエラーが出たら全プラットフォーム共通の
// アプリ内トースト（showToast）で知らせて即 clearError する（round-3 N1）。
// - iOS で 1 曲ごとに Alert が積み重なっていたため、Alert / ToastAndroid は使わない。
// - 曲名を含める。短時間に続いた失敗（自動スキップの連鎖）は 1 件のトーストにまとめる
//   （トーストは 1 枠なので、まとめた文言で上書きする）。
// player.ts（@crateforge/core）はプラットフォーム非依存に保ちたいので、
// 実際の通知表示はこのモバイル側コンポーネントが担当する。

import { useEffect, useRef } from "react";

import { usePlayer } from "@crateforge/core";

import { showToast } from "@/components/Toast";

/** 直前の失敗からこの時間内に起きた失敗は「連続失敗」として 1 件にまとめる（ms）。 */
export const PLAYBACK_ERROR_BURST_MS = 8000;

type PlaybackError = { message: string; at: number; title?: string | null; stopped?: boolean };

/** トースト文言。count は連続失敗の通算（1 なら単発）。 */
export function playbackErrorToastMessage(err: PlaybackError, count: number): string {
  const title = err.title?.trim() ? err.title.trim() : null;
  if (err.stopped) {
    return count > 1 ? `${err.message}（${count} 曲）` : err.message;
  }
  if (count > 1) {
    return title
      ? `再生できない曲を ${count} 曲スキップしました（直近: 「${title}」）`
      : `再生できない曲を ${count} 曲スキップしました`;
  }
  return title ? `「${title}」: ${err.message}` : err.message;
}

export default function PlaybackErrorToast() {
  const lastError = usePlayer((s) => s.lastError);
  const clearError = usePlayer((s) => s.clearError);
  // 同じエラーオブジェクトで二重発火しないよう、処理済みの at を覚えておく。
  const handledAt = useRef<number | null>(null);
  // 連続失敗のまとめ用（直近の失敗時刻と通算件数）。
  const burst = useRef<{ lastAt: number; count: number } | null>(null);

  useEffect(() => {
    if (!lastError) return;
    if (handledAt.current === lastError.at) return;
    handledAt.current = lastError.at;

    const prev = burst.current;
    const count =
      prev && lastError.at - prev.lastAt <= PLAYBACK_ERROR_BURST_MS ? prev.count + 1 : 1;
    // 連続失敗で停止したらまとめを締める（次の失敗は新しい 1 件目として数える）。
    burst.current = lastError.stopped ? null : { lastAt: lastError.at, count };

    showToast(playbackErrorToastMessage(lastError, count), "error");
    // 表示したので消費する（次の同文言エラーも at が変わるので再通知できる）。
    clearError();
  }, [lastError, clearError]);

  return null;
}
