// Google Cast 再生先 UI の表示用ヘルパー (純粋関数)。
import type { CastConnectionState, CastError, CastStatus } from "../api/cast";

/** 接続状態のラベル (UI 表示用)。idle/connected は表示しない前提で空文字。 */
export function castStateLabel(state: CastConnectionState): string {
  switch (state) {
    case "discovering":
      return "検索中…";
    case "connecting":
      return "接続中…";
    case "buffering":
      return "バッファリング中…";
    case "reconnecting":
      return "再接続中…";
    case "disconnected":
      return "切断";
    case "error":
      return "エラー";
    case "connected":
      return "接続済み";
    case "idle":
      return "";
  }
}

/** ボタンのバッジ用: 注意を引くべき状態か。 */
export function castStateTone(state: CastConnectionState): "busy" | "bad" | "ok" | null {
  switch (state) {
    case "connecting":
    case "buffering":
    case "reconnecting":
    case "discovering":
      return "busy";
    case "disconnected":
    case "error":
      return "bad";
    case "connected":
      return "ok";
    case "idle":
      return null;
  }
}

/**
 * CastErrorCode を、原因と対処が分かる日本語に変換する。
 * バックエンドの message は詳細として INTERNAL / LOAD_FAILED のときだけ添える
 * (トークン等は載らない契約だが、通常 UI は簡潔に保つ)。
 */
export function castErrorText(err: CastError): string {
  switch (err.code) {
    case "LAN_DISABLED":
      return "キャストには API サーバーの LAN 公開が必要です。設定 → AI 連携 / API から有効にしてください";
    case "DEVICE_NOT_FOUND":
      return "キャスト端末が見つかりません。電源と同じ LAN にいるかを確認し、再検索してください";
    case "CONNECT_FAILED":
      return "キャスト端末に接続できませんでした。同じ LAN か・ファイアウォールが通信を止めていないかを確認して再試行してください";
    case "LAUNCH_FAILED":
      return "キャスト先で再生アプリを起動できませんでした。端末を再起動してから再試行してください";
    case "UNSUPPORTED_FORMAT":
      return "この曲の形式はキャストに未対応です (対応: MP3 / AAC (M4A))";
    case "TRACK_UNAVAILABLE":
      return "音源ファイルが見つからないためキャストできません";
    case "LOAD_FAILED":
      return withDetail("キャスト先で曲を読み込めませんでした", err.message);
    case "PREVIEW_ACTIVE":
      return "Preview 中は再生先を切り替えられません。Esc で Preview を終了してから選び直してください";
    case "CONNECTION_LOST":
      return "キャスト先との接続が切れました。PC からは自動で再生しません";
    case "SUPERSEDED":
      return "";
    case "INTERNAL":
      return withDetail("キャストに失敗しました", err.message);
  }
}

function withDetail(base: string, detail: string): string {
  const d = detail.trim();
  return d ? `${base}: ${d}` : base;
}

/** 再生先ボタンの title (ツールチップ)。 */
export function castButtonTitle(s: CastStatus): string {
  if (s.target.type === "local") return "再生先: このコンピューター";
  const label = castStateLabel(s.connectionState);
  return `再生先: ${s.target.deviceName}${label ? ` (${label})` : ""}`;
}
