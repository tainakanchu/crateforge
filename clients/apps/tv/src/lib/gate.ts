// 接続状態から「/connect と / のどちらへ送るか」を決める（純関数。_layout の Gate が使う）。

import type { ConnectionStatus } from "@crateforge/core";

export interface GateInput {
  status: ConnectionStatus;
  /** 保存済みの接続先に届かないだけ（core の selectIsOffline）。接続監視が自動で再試行する。 */
  offline: boolean;
  /** いま /connect 画面にいるか。 */
  onConnect: boolean;
}

/**
 * 送り先。null は「そのまま」。
 * - 接続先が無い（idle）/ トークン不一致など入れ直しが必要なエラー → /connect。
 * - 接続先に届かないだけ（offline）は /connect へ飛ばさない。画面はそのまま、シェルの
 *   バナーで知らせ、接続監視（useConnectionMonitor）が戻り次第 "connected" に復帰させる。
 * - 接続できたら /connect から / へ。
 */
export function gateTarget({ status, offline, onConnect }: GateInput): "/connect" | "/" | null {
  const mustConnect = status === "idle" || (status === "error" && !offline);
  if (mustConnect && !onConnect) return "/connect";
  if (status === "connected" && onConnect) return "/";
  return null;
}
