// 接続状態の見張り。アプリのルートで 1 回だけ呼ぶ（mobile / TV の _layout）。
// - アプリが前面に戻ったら health を叩き直す（スリープ中の IP 変動・デスクトップ終了を検知）。
// - 前面かつ接続中は一定間隔で軽い health 確認（死活監視）。届かなくなったらオフラインへ。
// - 届かない（オフライン）間は一定間隔で再試行し、戻ったら自動で "connected" に復帰する。
// 実際の遷移ロジックは useConnection.recheck / reportError にある。

import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { selectIsOffline, useConnection } from "./connection";

export interface ConnectionMonitorOptions {
  /** オフライン中の再試行間隔（ms）。0 以下で無効。既定 15000。 */
  offlineRetryMs?: number;
  /** 接続中の死活監視間隔（ms）。0 以下で無効。既定 25000。 */
  heartbeatMs?: number;
}

/**
 * 接続の自動再確認フック。ルートレイアウトで `useConnectionMonitor()` と呼ぶだけでよい。
 * hydrate 完了前・接続情報なしの間は何もしない。401（トークン不一致）は自動再試行しない
 * （同じトークンでは直らないため。再接続画面で入れ直してもらう）。
 */
export function useConnectionMonitor(opts: ConnectionMonitorOptions = {}): void {
  const offlineRetryMs = opts.offlineRetryMs ?? 15000;
  const heartbeatMs = opts.heartbeatMs ?? 25000;
  const hydrated = useConnection((s) => s.hydrated);
  const isOffline = useConnection(selectIsOffline);
  const isConnected = useConnection((s) => s.status === "connected");

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

  // 定期確認（前面にいる間だけ）。オフライン中は再試行、接続中は死活監視（静かに）。
  // 1 本のタイマーに統合し、状態が変わったら間隔を張り直す。
  const intervalMs = !hydrated ? 0 : isOffline ? offlineRetryMs : isConnected ? heartbeatMs : 0;
  const silent = !isOffline;
  useEffect(() => {
    if (intervalMs <= 0) return;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      const s = useConnection.getState();
      if (s.status === "connecting") return;
      void s.recheck({ silent });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, silent]);
}
