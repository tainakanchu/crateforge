// 接続状態の表示ラベル（設定/接続画面共通）。status だけで「接続済み」と出さず、
// errorKind / checking / lastOkAt / selectIsOffline から日本語ラベルを決める。

import {
  type ConnectionState,
  apiErrorKindMessage,
  selectIsOffline,
} from "@crateforge/core";

export type ConnectionLabelTone = "ok" | "pending" | "offline" | "error" | "idle";

export interface ConnectionLabel {
  /** 短いラベル（状態行に表示）。 */
  text: string;
  tone: ConnectionLabelTone;
  /** 補足の説明（エラー時の対処など）。無ければ null。 */
  detail: string | null;
}

type Input = Pick<
  ConnectionState,
  "status" | "errorKind" | "checking" | "lastOkAt" | "baseUrl"
>;

/** epoch ms → "hh:mm"（端末ローカル時刻）。 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function connectionLabel(s: Input): ConnectionLabel {
  if (s.status === "connecting" || (s.checking && s.status !== "idle")) {
    return { text: "確認中", tone: "pending", detail: null };
  }
  if (s.status === "connected") {
    return { text: "接続済み", tone: "ok", detail: null };
  }
  if (s.status === "error") {
    if (s.errorKind === "unauthorized") {
      return { text: "トークン不一致", tone: "error", detail: apiErrorKindMessage("unauthorized") };
    }
    if (selectIsOffline(s)) {
      const text = s.lastOkAt != null ? `オフライン（最終接続 ${formatClock(s.lastOkAt)}）` : "オフライン";
      return { text, tone: "offline", detail: apiErrorKindMessage(s.errorKind ?? "network") };
    }
    return {
      text: "エラー",
      tone: "error",
      detail: s.errorKind ? apiErrorKindMessage(s.errorKind) : null,
    };
  }
  return { text: "未接続", tone: "idle", detail: null };
}
