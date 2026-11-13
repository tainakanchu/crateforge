// core の API エラー分類・日本語メッセージ・クエリ契約（Round 1: B1/B3/B7/B9）。

import {
  ApiClient,
  ApiError,
  DESKTOP_API_SETTINGS_PATH,
  InvalidResponseError,
  NetworkError,
  classifyApiError,
  describeApiError,
  filterAlbumTracks,
  isAuthError,
  isConnectivityError,
  type Track,
} from "@crateforge/core";

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function response(body: string, status: number, contentType = "application/json"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

describe("stream / download クエリ（B1/B9）", () => {
  const client = new ApiClient({ baseUrl: "http://h:1", token: "tok" });

  it("streamSource の native は true で送る（1 は古いホストで 400）", () => {
    expect(client.streamSource(5, { native: true }).uri).toBe(
      "http://h:1/api/tracks/5/stream?native=true",
    );
    expect(client.streamSource(5, { forceAac: true }).uri).toBe(
      "http://h:1/api/tracks/5/stream?fmt=aac",
    );
  });

  it("原本ダウンロード URL は original=true&native=true", () => {
    expect(client.downloadUrl(5, "original")).toBe(
      "http://h:1/api/tracks/5/stream?original=true&native=true&token=tok",
    );
    expect(client.downloadUrl(5, "aac192")).toBe(
      "http://h:1/api/tracks/5/stream?fmt=aac&br=192&token=tok",
    );
  });
});

describe("ApiClient の失敗の型（B7）", () => {
  const client = new ApiClient({ baseUrl: "http://h:1", token: "tok" });

  it("fetch 自体の失敗は NetworkError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(classifyApiError(err)).toBe("network");
    expect(isConnectivityError(err)).toBe(true);
  });

  it("2xx だが JSON でない応答は InvalidResponseError", async () => {
    fetchMock.mockResolvedValueOnce(response("<html>router</html>", 200, "text/html"));
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
    expect(describeApiError(err)).toMatch(/Crateforge の API ではない URL/);
  });

  it("HTML のエラー応答は本文を載せず notCrateforge に分類", async () => {
    fetchMock.mockResolvedValueOnce(response("<!doctype html><p>Not Found</p>", 404, "text/html"));
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("HTTP 404");
    expect(classifyApiError(err)).toBe("notCrateforge");
  });

  it("onError フックに失敗が通知される（AbortError は除く）", async () => {
    const onError = jest.fn();
    const c = new ApiClient({ baseUrl: "http://h:1", token: "tok", onError });
    fetchMock.mockResolvedValueOnce(response("", 401));
    await expect(c.health()).rejects.toBeInstanceOf(ApiError);
    expect(onError).toHaveBeenCalledTimes(1);

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValueOnce(abort);
    await expect(c.health()).rejects.toBe(abort);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("describeApiError（B7）", () => {
  it("401 はトークン確認の案内（設定の場所つき）", () => {
    const e = new ApiError(401, "HTTP 401");
    expect(isAuthError(e)).toBe(true);
    expect(describeApiError(e)).toBe(
      `トークンが違います。デスクトップの ${DESKTOP_API_SETTINGS_PATH} で確認してください`,
    );
  });

  it("ネットワーク失敗は Wi-Fi / 起動確認の案内", () => {
    expect(describeApiError(new NetworkError("Network request failed"))).toBe(
      "デスクトップに接続できません（同じ Wi-Fi にいるか、アプリが起動しているか確認してください）",
    );
    // ApiClient を通らない fetch（ダウンロード等）の TypeError も同じ扱い。
    expect(classifyApiError(new TypeError("Network request failed"))).toBe("network");
  });

  it("タイムアウト・403・5xx・action 付き", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyApiError(abort)).toBe("timeout");
    expect(classifyApiError(new ApiError(403, ""))).toBe("forbidden");
    expect(describeApiError(new ApiError(500, "boom"))).toBe(
      "デスクトップ側でエラーが発生しました（HTTP 500）",
    );
    expect(describeApiError(new ApiError(409, "cast"), { action: "再生" })).toMatch(
      /^再生に失敗しました: 再生先の状態により/,
    );
  });

  it("未知の例外は元のメッセージを添える", () => {
    expect(describeApiError(new Error("weird"))).toBe("エラーが発生しました（weird）");
  });
});

describe("リモート API（B3）", () => {
  const client = new ApiClient({ baseUrl: "http://h:1", token: null });

  it("remotePlayAt は index を送る", async () => {
    fetchMock.mockResolvedValueOnce(response(JSON.stringify({ trackId: 9 }), 200));
    await expect(client.remotePlayAt(2)).resolves.toEqual({ trackId: 9 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://h:1/api/remote/play-at");
    expect(JSON.parse(init.body)).toEqual({ index: 2 });
  });

  it("remoteSetQueue は play 指定時だけ play:true を載せる", async () => {
    fetchMock.mockResolvedValue(response("", 204));
    await client.remoteSetQueue([1, 2], 1, { play: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      trackIds: [1, 2],
      startIndex: 1,
      play: true,
    });
    await client.remoteSetQueue([1, 2], 1);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ trackIds: [1, 2], startIndex: 1 });
  });

  it("volume / shuffle / repeat", async () => {
    fetchMock.mockResolvedValue(response("", 204));
    await client.remoteVolume(1.5);
    await client.remoteShuffle(true);
    await client.remoteRepeat("one");
    const bodies = fetchMock.mock.calls.map((c) => [c[0], JSON.parse(c[1].body)]);
    expect(bodies).toEqual([
      ["http://h:1/api/remote/volume", { volume: 1 }],
      ["http://h:1/api/remote/shuffle", { on: true }],
      ["http://h:1/api/remote/repeat", { mode: "one" }],
    ]);
  });
});

describe("filterAlbumTracks（B5）", () => {
  const t = (trackId: number, album: string | null, albumArtist: string | null = null) =>
    ({ trackId, album, albumArtist }) as Track;

  it("album 名は完全一致（部分一致の別アルバムを除く）", () => {
    const tracks = [t(1, "Dawn"), t(2, "Dawn (Remixes)"), t(3, " Dawn "), t(4, "dawn")];
    expect(filterAlbumTracks(tracks, "Dawn").map((x) => x.trackId)).toEqual([1, 3]);
  });

  it("albumArtist 指定時は別のアルバムアーティストを除き、未設定は残す", () => {
    const tracks = [t(1, "Best", "A"), t(2, "Best", "B"), t(3, "Best", null)];
    expect(filterAlbumTracks(tracks, "Best", "A").map((x) => x.trackId)).toEqual([1, 3]);
    expect(filterAlbumTracks(tracks, "Best", null).map((x) => x.trackId)).toEqual([1, 2, 3]);
  });
});
