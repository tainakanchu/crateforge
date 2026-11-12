// 接続ストアの状態遷移（Round 1: B6）。通信エラーで「接続済み」のまま残らないこと。

import * as SecureStore from "expo-secure-store";

import { ApiError, NetworkError, selectIsOffline, useConnection } from "@crateforge/core";

const healthBody = { name: "crateforge", version: "0.7.1", trackCount: 3 };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = jest.fn();
const getItem = SecureStore.getItemAsync as jest.Mock;

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  getItem.mockReset().mockResolvedValue(null);
  useConnection.setState({
    baseUrl: null,
    token: null,
    status: "idle",
    error: null,
    errorKind: null,
    client: null,
    hydrated: false,
    checking: false,
  });
});

async function connected(): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse(healthBody));
  await useConnection.getState().connect("h:1", "tok");
  expect(useConnection.getState().status).toBe("connected");
}

describe("hydrate", () => {
  it("SecureStore が失敗しても hydrated=true になる", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    getItem.mockRejectedValue(new Error("secure store unavailable"));
    await useConnection.getState().hydrate();
    const st = useConnection.getState();
    expect(st.hydrated).toBe(true);
    expect(st.status).toBe("idle");
  });

  it("保存先に届かなければ error + network（オフライン扱い）", async () => {
    getItem.mockImplementation(async (k: string) => (k === "crateforge.baseUrl" ? "http://h:2" : null));
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    await useConnection.getState().hydrate();
    const st = useConnection.getState();
    expect(st.status).toBe("error");
    expect(st.errorKind).toBe("network");
    expect(st.error).toMatch(/デスクトップに接続できません/);
    expect(selectIsOffline(st)).toBe(true);
  });
});

describe("接続中の通信エラー", () => {
  it("API 呼び出しの 401 で即 error(unauthorized) になり client が外れる", async () => {
    await connected();
    fetchMock.mockResolvedValueOnce(jsonResponse("", 401));
    await expect(useConnection.getState().client!.stats()).rejects.toBeInstanceOf(ApiError);
    const st = useConnection.getState();
    expect(st.status).toBe("error");
    expect(st.errorKind).toBe("unauthorized");
    expect(st.client).toBeNull();
    expect(st.error).toMatch(/トークンが違います/);
    expect(selectIsOffline(st)).toBe(false);
  });

  it("ネットワーク断は health で確かめてからオフラインへ遷移する", async () => {
    await connected();
    // stats 失敗 → recheck の health も失敗。
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await expect(useConnection.getState().client!.stats()).rejects.toBeInstanceOf(NetworkError);
    await waitForIdleRecheck();
    const st = useConnection.getState();
    expect(st.status).toBe("error");
    expect(st.errorKind).toBe("network");
    expect(st.client).toBeNull();
    expect(st.baseUrl).toBe("http://h:1"); // 再接続用に保持
  });

  it("単発の失敗でも health が通れば接続済みのまま（client も同一）", async () => {
    await connected();
    const before = useConnection.getState().client;
    fetchMock
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(jsonResponse(healthBody));
    await expect(before!.stats()).rejects.toBeInstanceOf(NetworkError);
    await waitForIdleRecheck();
    const st = useConnection.getState();
    expect(st.status).toBe("connected");
    expect(st.client).toBe(before);
  });

  it("recheck でオフラインから復帰する", async () => {
    useConnection.setState({
      baseUrl: "http://h:1",
      token: "tok",
      status: "error",
      errorKind: "network",
      client: null,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(healthBody));
    await expect(useConnection.getState().recheck()).resolves.toBe(true);
    const st = useConnection.getState();
    expect(st.status).toBe("connected");
    expect(st.client?.token).toBe("tok");
    expect(st.errorKind).toBeNull();
  });
});

/** reportError → recheck は非同期で走るので、checking が落ちるまで待つ。 */
async function waitForIdleRecheck(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    if (!useConnection.getState().checking) return;
  }
}
