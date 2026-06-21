// ペアリングクライアントのユニットテスト。
// fetch をモックして pairStart / pairPoll が正しい URL を叩き、レスポンスを返すことを確認する。

import { ApiClient } from "@crateforge/core";

function mockFetch(body: unknown, status = 200) {
  return jest.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("ApiClient pairing", () => {
  const baseUrl = "http://192.168.1.10:8787";
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({ baseUrl, token: null });
    jest.restoreAllMocks();
  });

  describe("pairStart()", () => {
    it("POST /api/pair/start を呼び、session と code を返す", async () => {
      const spy = mockFetch({ session: "sess-abc", code: "123456" });

      const res = await client.pairStart();

      expect(spy).toHaveBeenCalledWith(
        `${baseUrl}/api/pair/start`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(res.session).toBe("sess-abc");
      expect(res.code).toBe("123456");
    });

    it("token がない場合は Authorization ヘッダを送らない", async () => {
      const spy = mockFetch({ session: "s", code: "000000" });
      await client.pairStart();

      const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-API-Token"]).toBeUndefined();
    });
  });

  describe("pairPoll()", () => {
    it("GET /api/pair/poll?session=<id> を呼び、pending 状態を返す", async () => {
      const spy = mockFetch({ status: "pending" });

      const res = await client.pairPoll("sess-abc");

      const calledUrl = spy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/pair/poll");
      expect(calledUrl).toContain("session=sess-abc");
      expect(res.status).toBe("pending");
      expect(res.token).toBeUndefined();
    });

    it("approved になると token を返す", async () => {
      mockFetch({ status: "approved", token: "secret-token-xyz" });

      const res = await client.pairPoll("sess-def");

      expect(res.status).toBe("approved");
      expect(res.token).toBe("secret-token-xyz");
    });

    it("expired になると token は undefined", async () => {
      mockFetch({ status: "expired" });

      const res = await client.pairPoll("sess-ghi");

      expect(res.status).toBe("expired");
      expect(res.token).toBeUndefined();
    });
  });

  describe("token 付き接続", () => {
    it("token がある場合は通常の API もヘッダ付きで呼ぶ", async () => {
      const authedClient = new ApiClient({ baseUrl, token: "my-token" });
      const spy = mockFetch({ status: "pending" });

      await authedClient.pairPoll("sess-xyz");

      const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-API-Token"]).toBe("my-token");
    });
  });
});
