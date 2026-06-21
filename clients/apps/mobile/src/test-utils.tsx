// テスト用ヘルパ。各 slice のテストはここを import して
// React Query ラッパ・接続状態・fetch モックを組み立てる。

import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiClient, useConnection, useDownloads, resetPlayer } from "@crateforge/core";

/** リトライ無し・キャッシュ無しの新しい QueryClient を持つラッパを返す。 */
export function createQueryWrapper(): (props: { children: ReactNode }) => ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

export interface TestConnectionOptions {
  baseUrl?: string;
  token?: string | null;
}

/** 接続済み状態（ApiClient 付き）をセットし、その client を返す。 */
export function setTestConnection(opts: TestConnectionOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? "http://localhost:8787";
  const token = opts.token ?? null;
  const client = new ApiClient({ baseUrl, token });
  useConnection.setState({ client, status: "connected", baseUrl, token, error: null });
  return client;
}

export interface MockResponse {
  body: unknown;
  status?: number;
}

/** 渡した順に返す fetch モックをセットしてその jest.fn を返す。 */
export function mockFetch(...responses: MockResponse[]): jest.Mock {
  let i = 0;
  const fn = jest.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = r?.status ?? 200;
    const body = r?.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** プレイヤー・接続・ダウンロード状態を初期化する（各テストの beforeEach 用）。 */
export function resetTestState(): void {
  resetPlayer();
  useConnection.setState({
    client: null,
    status: "idle",
    baseUrl: null,
    token: null,
    error: null,
  });
  useDownloads.setState({ entries: {}, downloading: {} });
}
