import { useCallback } from "react";
import { useStore } from "../store/useStore";
import { runTrackAction } from "../lib/trackActions";
import type { TrackActionKind } from "../lib/trackActions";

export type TrackActionRunner = (
  kind: TrackActionKind,
  action: () => Promise<unknown>,
  trackName?: string,
) => Promise<boolean>;

/**
 * 曲操作を実行し、失敗をエラートーストで知らせる関数を返す (`runTrackAction` + `pushToast`)。
 * 成功時の処理 (再読み込み・成功トースト) は action の中に書く。
 */
export function useTrackActionRunner(): TrackActionRunner {
  const pushToast = useStore((s) => s.pushToast);
  return useCallback<TrackActionRunner>(
    (kind, action, trackName) =>
      runTrackAction((message) => pushToast("error", message), kind, action, trackName),
    [pushToast],
  );
}
