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

/** 未接続時の復帰導線の種類。 */
export type RecoveryAction = "reauth" | "retry" | "connect";

export interface ConnectionRecovery {
  /** 1 行の理由（未接続表示のバナーに出す）。 */
  reason: string;
  action: RecoveryAction;
  /** 導線ボタンの文言。 */
  actionLabel: string;
}

/** 接続画面へトークン再入力モードで行く href（旧トークンは入れない）。 */
export const REAUTH_HREF = "/connect?reauth=1";

/**
 * 未接続（client なし）のときの理由 1 行と復帰導線（ライブラリ/プレイリスト/リモート/設定で共通）。
 * - トークン不一致: 「トークンを入力し直す」（URL 入りの接続画面へ。旧トークンは入れない）
 * - オフライン（デスクトップに届かない）: 「再試行」（同じ接続先で health を叩き直す）
 * - それ以外（未設定・その他のエラー）: 「サーバーに接続」（接続画面へ）
 */
export function connectionRecovery(s: Input): ConnectionRecovery {
  if (s.status === "error" && s.errorKind === "unauthorized") {
    return {
      reason: "トークンが一致しません（デスクトップでトークンが変更された可能性があります）",
      action: "reauth",
      actionLabel: "トークンを入力し直す",
    };
  }
  if (s.status === "error" && s.errorKind === "notCrateforge") {
    // 同じ URL で再試行しても直らないので接続画面で URL を直してもらう。
    return { reason: "接続先が Crateforge ではありません", action: "connect", actionLabel: "接続先を変更" };
  }
  if (selectIsOffline(s)) {
    const at = s.lastOkAt != null ? `（最終接続 ${formatClock(s.lastOkAt)}）` : "";
    return { reason: `デスクトップに届きません${at}`, action: "retry", actionLabel: "再試行" };
  }
  if (s.status === "error" && s.errorKind) {
    return { reason: apiErrorKindMessage(s.errorKind), action: "connect", actionLabel: "サーバーに接続" };
  }
  return { reason: "サーバー未接続", action: "connect", actionLabel: "サーバーに接続" };
}
