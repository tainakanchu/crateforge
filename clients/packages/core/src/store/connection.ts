// サーバー接続情報（baseUrl + token）のストア。
// SecureStore に永続化し、起動時に hydrate して自動再接続する。
// 全データ取得は useConnection().client（接続中のみ非 null）経由で行う。

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { ApiClient, normalizeBaseUrl } from "../lib/api/client";

const KEY_URL = "crateforge.baseUrl";
const KEY_TOKEN = "crateforge.token";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface ConnectionState {
  baseUrl: string | null;
  token: string | null;
  status: ConnectionStatus;
  error: string | null;
  /** 接続確立後のみ非 null。 */
  client: ApiClient | null;

  /** 起動時に SecureStore から復元し、疎通確認する。 */
  hydrate: () => Promise<void>;
  /** 入力された URL/token で疎通確認し、成功なら永続化＆接続。戻り値は成否。 */
  connect: (baseUrl: string, token: string | null) => Promise<boolean>;
  /** 接続情報を破棄してログアウト。 */
  disconnect: () => Promise<void>;
}

/** baseUrl + token で疎通確認し、成功した ApiClient を返す。失敗は例外。 */
async function probe(baseUrl: string, token: string | null): Promise<ApiClient> {
  const client = new ApiClient({ baseUrl, token });
  // タイムアウト付きで health を叩く（LAN 不通時に固まらないように）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    await client.health(controller.signal);
    return client;
  } finally {
    clearTimeout(timer);
  }
}

export const useConnection = create<ConnectionState>((set) => ({
  baseUrl: null,
  token: null,
  status: "idle",
  error: null,
  client: null,

  hydrate: async () => {
    const [baseUrl, token] = await Promise.all([
      SecureStore.getItemAsync(KEY_URL),
      SecureStore.getItemAsync(KEY_TOKEN),
    ]);
    if (!baseUrl) {
      set({ status: "idle" });
      return;
    }
    set({ baseUrl, token: token ?? null, status: "connecting", error: null });
    try {
      const client = await probe(baseUrl, token ?? null);
      set({ client, status: "connected", error: null });
    } catch (e) {
      // 復元はしたが疎通失敗（サーバー停止/IP 変動など）。情報は保持し再接続を促す。
      set({ status: "error", error: errorMessage(e), client: null });
    }
  },

  connect: async (rawUrl, token) => {
    const baseUrl = normalizeBaseUrl(rawUrl);
    if (baseUrl === "") {
      set({ status: "error", error: "URL を入力してください" });
      return false;
    }
    set({ status: "connecting", error: null, baseUrl, token });
    try {
      const client = await probe(baseUrl, token);
      await Promise.all([
        SecureStore.setItemAsync(KEY_URL, baseUrl),
        token
          ? SecureStore.setItemAsync(KEY_TOKEN, token)
          : SecureStore.deleteItemAsync(KEY_TOKEN),
      ]);
      set({ client, status: "connected", error: null });
      return true;
    } catch (e) {
      set({ status: "error", error: errorMessage(e), client: null });
      return false;
    }
  },

  disconnect: async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(KEY_URL),
      SecureStore.deleteItemAsync(KEY_TOKEN),
    ]);
    set({ baseUrl: null, token: null, client: null, status: "idle", error: null });
  },
}));

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return "接続がタイムアウトしました";
    return e.message;
  }
  return String(e);
}
