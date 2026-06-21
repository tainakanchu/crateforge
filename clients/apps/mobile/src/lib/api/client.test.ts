import { ApiClient, ApiError, buildQuery, normalizeBaseUrl, type Track } from "@crateforge/core";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("normalizeBaseUrl", () => {
  it("adds http scheme when missing", () => {
    expect(normalizeBaseUrl("192.168.1.5:8787")).toBe("http://192.168.1.5:8787");
  });
  it("keeps https and strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://host:9/")).toBe("https://host:9");
    expect(normalizeBaseUrl("http://host//")).toBe("http://host");
  });
  it("returns empty for blank", () => {
    expect(normalizeBaseUrl("   ")).toBe("");
  });
});

describe("buildQuery", () => {
  it("skips null/undefined and encodes", () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: "x y" })).toBe("?a=1&d=x%20y");
  });
  it("returns empty string for no params", () => {
    expect(buildQuery()).toBe("");
    expect(buildQuery({ a: undefined })).toBe("");
  });
});

describe("ApiClient media + auth", () => {
  const client = new ApiClient({ baseUrl: "host:8787", token: "secret" });

  it("normalizes baseUrl in constructor", () => {
    expect(client.baseUrl).toBe("http://host:8787");
  });
  it("authHeaders include token", () => {
    expect(client.authHeaders()).toEqual({ "X-API-Token": "secret" });
    expect(new ApiClient({ baseUrl: "h", token: null }).authHeaders()).toEqual({});
  });
  it("mediaUrl appends token query", () => {
    expect(client.artworkUrl(7)).toBe("http://host:8787/api/tracks/7/artwork?token=secret");
  });
  it("streamSource carries headers", () => {
    expect(client.streamSource(9)).toEqual({
      uri: "http://host:8787/api/tracks/9/stream",
      headers: { "X-API-Token": "secret" },
    });
  });
});

describe("ApiClient requests", () => {
  const client = new ApiClient({ baseUrl: "http://h:1", token: "t" });

  it("GET listTracks builds query and sends auth header", async () => {
    const tracks: Partial<Track>[] = [{ id: 1, trackId: 1 }];
    fetchMock.mockResolvedValueOnce(jsonResponse(tracks));
    const out = await client.listTracks({ q: "jazz", genre: "house", limit: 10 });
    expect(out).toEqual(tracks);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://h:1/api/tracks?q=jazz&genre=house&limit=10");
    expect(init.method).toBe("GET");
    expect(init.headers["X-API-Token"]).toBe("t");
  });

  it("POST remoteSeek sends JSON body and content-type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await client.remoteSeek(1234);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://h:1/api/remote/seek");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ positionMs: 1234 });
  });

  it("POST tracksByIds posts trackIds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await client.tracksByIds([3, 1, 2]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ trackIds: [3, 1, 2] });
  });

  it("throws ApiError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 403));
    await expect(client.listTracks()).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 403));
    await expect(client.listTracks()).rejects.toMatchObject({ status: 403 });
  });

  it("health hits /api/health", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ name: "crateforge", version: "0.7.1", trackCount: 5 }),
    );
    const h = await client.health();
    expect(h.name).toBe("crateforge");
    expect(fetchMock.mock.calls[0][0]).toBe("http://h:1/api/health");
  });
});
