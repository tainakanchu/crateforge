import { invoke } from "@tauri-apps/api/core";

export interface ApiServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string | null;
  lanEnabled: boolean;
  token: string | null;
  lanUrls: string[];
}

/// API サーバーの現在の状態を取得。
export async function getApiServerStatus(): Promise<ApiServerStatus> {
  return invoke("get_api_server_status");
}

/// API サーバーの設定を更新し、必要に応じて起動／停止する。
/// bind 失敗時は throw される（enabled は保存されるが running=false になる）。
export async function setApiServerConfig(
  enabled: boolean,
  port: number,
): Promise<ApiServerStatus> {
  return invoke("set_api_server_config", { enabled, port });
}

/// LAN 公開を有効／無効にする。有効化時にトークンが自動生成される。
export async function setApiLanEnabled(enabled: boolean): Promise<ApiServerStatus> {
  return invoke("set_api_lan_enabled", { enabled });
}

/// アクセストークンを再生成する。既存の URL のトークンは無効になる。
export async function regenerateApiToken(): Promise<ApiServerStatus> {
  return invoke("regenerate_api_token");
}

/// QR コードを SVG 文字列として生成する。
export async function lanQrSvg(data: string): Promise<string> {
  return invoke("lan_qr_svg", { data });
}

/// ペアリングコードを入力して TV/モバイル端末を承認する。
/// - true: 承認成功。
/// - false: コードが見つからない / 有効期限切れ。
/// - throws: LAN トークンが無効（LAN 無効時）。
export async function approvePairing(code: string): Promise<boolean> {
  return invoke("approve_pairing", { code });
}

/// 未承認ペアリングセッション一覧を返す（デスクトップ UI 向け）。
export interface PairingInfo {
  code: string;
  ageSecs: number;
}

export async function listPendingPairings(): Promise<PairingInfo[]> {
  return invoke("list_pending_pairings");
}
