// API エラー → 種別 / 日本語メッセージの共通変換。
// 接続画面・リモート操作・ダウンロード失敗などの UI はここを通して文言を出す
// （画面ごとに `e.message` を生で出すと "HTTP 401" や HTML 本文がそのまま見えてしまうため）。

import { ApiError, InvalidResponseError, NetworkError, isAbortError } from "./client";

/**
 * デスクトップ側で LAN 公開・トークンを確認する場所（案内文用）。
 * デスクトップの設定タブ名が変わったらここだけ直す。
 */
export const DESKTOP_API_SETTINGS_PATH = "設定 → モバイル / API";

/** エラーの種別。UI の出し分け（再接続誘導・オフライン切替など）に使う。 */
export type ApiErrorKind =
  /** 401: トークンが違う / 失効した。 */
  | "unauthorized"
  /** 403: LAN 公開が無効・トークン未生成、またはこの操作が LAN から許可されていない。 */
  | "forbidden"
  /** ホストに到達できない（Wi-Fi 違い・アプリ未起動・IP 変動）。 */
  | "network"
  /** タイムアウト / 中断。 */
  | "timeout"
  /** 応答が JSON ではない・HTML が返った（Crateforge の API ではない URL）。 */
  | "notCrateforge"
  /** 404。 */
  | "notFound"
  /** 409: 再生先（Cast）の状態などで操作できない。 */
  | "conflict"
  /** 400 / 422 などのリクエスト不正。 */
  | "badRequest"
  /** 5xx。 */
  | "server"
  | "unknown";

/** 例外を種別に分類する。 */
export function classifyApiError(e: unknown): ApiErrorKind {
  if (e instanceof NetworkError) return "network";
  if (e instanceof InvalidResponseError) return "notCrateforge";
  if (isAbortError(e)) return "timeout";
  if (e instanceof ApiError) {
    if (e.status === 401) return "unauthorized";
    if (e.htmlBody) return "notCrateforge";
    if (e.status === 403) return "forbidden";
    if (e.status === 404) return "notFound";
    if (e.status === 408 || e.status === 504) return "timeout";
    if (e.status === 409) return "conflict";
    if (e.status >= 500) return "server";
    if (e.status >= 400) return "badRequest";
    return "unknown";
  }
  // ApiClient を経由しない fetch（expo-file-system のダウンロード等）の失敗。
  if (e instanceof TypeError && /network request failed|failed to fetch|network/i.test(e.message)) {
    return "network";
  }
  if (e instanceof SyntaxError) return "notCrateforge";
  return "unknown";
}

/** 401（トークン不一致・失効）か。再接続（トークン再入力/再ペアリング）へ誘導する判定に使う。 */
export function isAuthError(e: unknown): boolean {
  return classifyApiError(e) === "unauthorized";
}

/** デスクトップに届いていない系（ネットワーク断・タイムアウト・別サーバー）か。オフライン切替の判定に使う。 */
export function isConnectivityError(e: unknown): boolean {
  const k = classifyApiError(e);
  return k === "network" || k === "timeout" || k === "notCrateforge";
}

/** 種別ごとの既定の日本語メッセージ。 */
export function apiErrorKindMessage(kind: ApiErrorKind): string {
  switch (kind) {
    case "unauthorized":
      return `トークンが違います。デスクトップの ${DESKTOP_API_SETTINGS_PATH} で確認してください`;
    case "forbidden":
      return `デスクトップがこの操作を許可していません。${DESKTOP_API_SETTINGS_PATH} で LAN 公開とトークンを確認してください`;
    case "network":
      return "デスクトップに接続できません（同じ Wi-Fi にいるか、アプリが起動しているか確認してください）";
    case "timeout":
      return "接続がタイムアウトしました（同じ Wi-Fi にいるか、アプリが起動しているか確認してください）";
    case "notCrateforge":
      return "Crateforge の API ではない URL です。デスクトップに表示されている URL を確認してください";
    case "notFound":
      return "見つかりません（デスクトップ側で削除されたか、デスクトップのバージョンが古い可能性があります）";
    case "conflict":
      return "再生先の状態により操作できませんでした（キャスト先の接続を確認してください）";
    case "badRequest":
      return "リクエストが受け付けられませんでした（デスクトップのバージョンが古い可能性があります）";
    case "server":
      return "デスクトップ側でエラーが発生しました";
    case "unknown":
    default:
      return "エラーが発生しました";
  }
}

/**
 * 例外を UI 表示用の日本語メッセージへ変換する。
 * - opts.action を渡すと「<action>に失敗しました: <理由>」の形にする（例: "再生" → 「再生に失敗しました: …」）。
 * - 種別が unknown のときは元のメッセージを括弧で添える（原因切り分け用）。
 */
export function describeApiError(e: unknown, opts?: { action?: string }): string {
  const kind = classifyApiError(e);
  let msg = apiErrorKindMessage(kind);
  if (kind === "server" && e instanceof ApiError) msg += `（HTTP ${e.status}）`;
  if (kind === "unknown") {
    const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    if (raw) msg += `（${raw}）`;
  }
  return opts?.action ? `${opts.action}に失敗しました: ${msg}` : msg;
}
