// flushPending の衝突 / 冪等 / タグ適用テスト。ApiClient はモック。

import { ApiClient, ApiError } from "@crateforge/core";

import { usePendingEdits } from "@/store/pendingEdits";
import { flushPending, keepMine, keepServer } from "../syncPending";

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getTrack: jest.fn(),
    setRating: jest.fn(async () => undefined),
    addTrackTags: jest.fn(async () => ({ updated: 1 })),
    removeTrackTags: jest.fn(async () => ({ updated: 1 })),
    ...overrides,
  } as unknown as ApiClient;
}

beforeEach(() => {
  usePendingEdits.setState({
    ops: [],
    conflicts: [],
    flushing: false,
    hydrated: true,
  });
});

describe("flushPending rating", () => {
  it("base 一致なら setRating してキューから消す", async () => {
    usePendingEdits.getState().enqueue({
      kind: "rating",
      trackId: 1,
      rating: 100,
      baseRating: 80,
      trackName: "A",
    });
    const client = mockClient({
      getTrack: jest.fn(async () => ({ id: 1, rating: 80 }) as never),
    });

    const result = await flushPending(client);
    expect(result.applied).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(client.setRating).toHaveBeenCalledWith(1, 100);
    expect(usePendingEdits.getState().ops).toHaveLength(0);
  });

  it("既に目的値なら setRating を呼ばず消す", async () => {
    usePendingEdits.getState().enqueue({
      kind: "rating",
      trackId: 2,
      rating: 60,
      baseRating: 40,
    });
    const client = mockClient({
      getTrack: jest.fn(async () => ({ id: 2, rating: 60 }) as never),
    });

    const result = await flushPending(client);
    expect(result.applied).toBe(1);
    expect(client.setRating).not.toHaveBeenCalled();
    expect(usePendingEdits.getState().ops).toHaveLength(0);
  });

  it("真の衝突は setRating せず conflicts に移す", async () => {
    usePendingEdits.getState().enqueue({
      kind: "rating",
      trackId: 3,
      rating: 100,
      baseRating: 80,
      trackName: "Conflict Song",
    });
    const client = mockClient({
      getTrack: jest.fn(async () => ({ id: 3, rating: 40 }) as never),
    });

    const result = await flushPending(client);
    expect(result.conflicts).toBe(1);
    expect(result.applied).toBe(0);
    expect(client.setRating).not.toHaveBeenCalled();
    expect(usePendingEdits.getState().ops).toHaveLength(0);
    expect(usePendingEdits.getState().conflicts).toHaveLength(1);
    expect(usePendingEdits.getState().conflicts[0].serverRating).toBe(40);
  });
});

describe("flushPending tags", () => {
  it("tag-add を適用して消す", async () => {
    usePendingEdits.getState().enqueue({
      kind: "tag-add",
      trackId: 9,
      tag: "mood:chill",
    });
    const client = mockClient();
    const result = await flushPending(client);
    expect(result.applied).toBe(1);
    expect(client.addTrackTags).toHaveBeenCalledWith([9], "mood:chill");
    expect(usePendingEdits.getState().ops).toHaveLength(0);
  });

  it("review-later は review:later タグとして書き戻す", async () => {
    usePendingEdits.getState().enqueue({
      kind: "review-later",
      trackId: 5,
    });
    const client = mockClient();
    await flushPending(client);
    expect(client.addTrackTags).toHaveBeenCalledWith([5], "review:later");
  });

  it("タグ API 404 は unsupported として捨てる", async () => {
    usePendingEdits.getState().enqueue({
      kind: "tag-add",
      trackId: 1,
      tag: "x",
    });
    const client = mockClient({
      addTrackTags: jest.fn(async () => {
        throw new ApiError(404, "not found");
      }),
    });
    const result = await flushPending(client);
    expect(result.skippedUnsupported).toBe(1);
    expect(usePendingEdits.getState().ops).toHaveLength(0);
  });
});

describe("conflict resolution", () => {
  it("keepMine は setRating して conflict を消す", async () => {
    usePendingEdits.setState({
      conflicts: [
        {
          id: "c1",
          op: {
            id: "c1",
            kind: "rating",
            trackId: 7,
            rating: 100,
            baseRating: 80,
            createdAt: "t",
          },
          serverRating: 40,
          detectedAt: "t",
        },
      ],
    });
    const client = mockClient();
    const ok = await keepMine(client, "c1");
    expect(ok).toBe(true);
    expect(client.setRating).toHaveBeenCalledWith(7, 100);
    expect(usePendingEdits.getState().conflicts).toHaveLength(0);
  });

  it("keepServer は conflict を捨てるだけ", () => {
    usePendingEdits.setState({
      conflicts: [
        {
          id: "c2",
          op: {
            id: "c2",
            kind: "rating",
            trackId: 8,
            rating: 100,
            baseRating: 80,
            createdAt: "t",
          },
          serverRating: 20,
          detectedAt: "t",
        },
      ],
    });
    keepServer("c2");
    expect(usePendingEdits.getState().conflicts).toHaveLength(0);
  });
});
