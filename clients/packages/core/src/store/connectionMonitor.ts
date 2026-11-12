// 接続状態の見張り。アプリのルートで 1 回だけ呼ぶ（mobile / TV の _layout）。
// - アプリが前面に戻ったら health を叩き直す（スリープ中の IP 変動・デスクトップ終了を検知）。
// - 届かない（オフライン）間は一定間隔で再試行し、戻ったら自動で "connected" に復帰する。
// 実際の遷移ロジックは useConnection.recheck / reportError にある。

import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { selectIsOffline, useConnection } from "./connection";

export interface ConnectionMonitorOptions {
  /** オフライン中の再試行間隔（ms）。0 以下で無効。既定 15000。 */
  offlineRetryMs?: number;
}

/**
 * 接続の自動再確認フック。ルートレイアウトで `useConnectionMonitor()` と呼ぶだけでよい。
 * hydrate 完了前・接続情報なしの間は何もしない。401（トークン不一致）は自動再試行しない
 * （同じトークンでは直らないため。再接続画面で入れ直してもらう）。
 */
export function useConnectionMonitor(opts: ConnectionMonitorOptions = {}): void {
  const offlineRetryMs = opts.offlineRetryMs ?? 15000;
  const hydrated = useConnection((s) => s.hydrated);
  const isOffline = useConnection(selectIsOffline);

  // 前面復帰で再確認。
  useEffect(() => {
    if (!hydrated) return;
    let last: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      const cameToForeground = last !== "active" && next === "active";
      last = next;
      if (!cameToForeground) return;
      const s = useConnection.getState();
      if (!s.baseUrl || s.status === "connecting") return;
      if (s.status === "error" && s.errorKind === "unauthorized") return;
      void s.recheck();
    });
    return () => sub.remove();
  }, [hydrated]);

  // オフライン中は定期的に再試行（前面にいる間だけ）。
  useEffect(() => {
    if (!hydrated || !isOffline || offlineRetryMs <= 0) return;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void useConnection.getState().recheck();
    }, offlineRetryMs);
    return () => clearInterval(timer);
  }, [hydrated, isOffline, offlineRetryMs]);
}
