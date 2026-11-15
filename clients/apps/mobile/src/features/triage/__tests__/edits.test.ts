// 評価・タグ書き込み（writeRating / writeTag / writeReviewLater）のテスト。ApiClient はモック。

import { QueryClient } from "@tanstack/react-query";

import { ApiClient, ApiError, useConnection } from "@crateforge/core";

import { usePendingEdits } from "@/store/pendingEdits";
import {
  RATING_AFFECTED_KEYS,
  invalidateRatingQueries,
  queueReviewLater,
  writeRating,
  writeReviewLater,
  writeTag,
} from "../edits";

function connect(overrides: Partial<ApiClient> = {}): ApiClient {
  const client = {
    setRating: jest.fn(async () => undefined),
    addTrackTags: jest.fn(async () => ({ updated: 1 })),
    ...overrides,
  } as unknown as ApiClient;
  useConnection.setState({ client, status: "connected" });
  return client;
}

/** id / createdAt を除いた pending op。 */
function queuedOps() {
  return usePendingEdits.getState().ops.map(({ id: _id, createdAt: _createdAt, ...rest }) => rest);
}

beforeEach(() => {
  useConnection.setState({ client: null, status: "idle" });
  usePendingEdits.setState({ ops: [], conflicts: [], flushing: false, hydrated: true });
});

describe("writeRating", () => {
  it("オンラインは setRating して applied。キューには積まない", async () => {
    const client = connect();
    await expect(writeRating({ trackId: 1, rating: 70, baseRating: 40, trackName: "A" })).resolves.toBe(
      "applied",
    );
    expect(client.setRating).toHaveBeenCalledWith(1, 70);
    expect(queuedOps()).toEqual([]);
  });

  it("オンラインの失敗はそのまま投げ、キューには積まない", async () => {
    const boom = new ApiError(500, "HTTP 500");
    connect({ setRating: jest.fn(async () => Promise.reject(boom)) });
    await expect(writeRating({ trackId: 1, rating: 70 })).rejects.toBe(boom);
    expect(queuedOps()).toEqual([]);
  });

  it("オフラインは baseRating 付きでキューに積んで queued", async () => {
    await expect(writeRating({ trackId: 1, rating: 70, baseRating: 40, trackName: "A" })).resolves.toBe(
      "queued",
    );
    expect(queuedOps()).toEqual([
      { kind: "rating", trackId: 1, rating: 70, baseRating: 40, trackName: "A" },
    ]);
  });

  it("baseRating / trackName 省略時は null でキューに積む", async () => {
    await writeRating({ trackId: 2, rating: 0 });
    expect(queuedOps()).toEqual([
      { kind: "rating", trackId: 2, rating: 0, baseRating: null, trackName: null },
    ]);
  });
});

describe("writeTag", () => {
  it("オンラインは addTrackTags して applied", async () => {
    const client = connect();
    await expect(writeTag({ trackId: 3, tag: "mood:chill", trackName: "C" })).resolves.toBe("applied");
    expect(client.addTrackTags).toHaveBeenCalledWith([3], "mood:chill");
    expect(queuedOps()).toEqual([]);
  });

  it.each([404, 501])("ホストがタグ未対応 (%d) なら unsupported（投げない・積まない）", async (status) => {
    connect({ addTrackTags: jest.fn(async () => Promise.reject(new ApiError(status, "nope"))) });
    await expect(writeTag({ trackId: 3, tag: "mood:chill" })).resolves.toBe("unsupported");
    expect(queuedOps()).toEqual([]);
  });

  it("それ以外の失敗はそのまま投げる", async () => {
    const boom = new ApiError(403, "forbidden");
    connect({ addTrackTags: jest.fn(async () => Promise.reject(boom)) });
    await expect(writeTag({ trackId: 3, tag: "mood:chill" })).rejects.toBe(boom);
    expect(queuedOps()).toEqual([]);
  });

  it("オフラインは tag-add としてキューに積んで queued", async () => {
    await expect(writeTag({ trackId: 3, tag: "mood:chill", trackName: "C" })).resolves.toBe("queued");
    expect(queuedOps()).toEqual([{ kind: "tag-add", trackId: 3, tag: "mood:chill", trackName: "C" }]);
  });
});

describe("writeReviewLater", () => {
  it("オンラインは review:later タグを付けて applied", async () => {
    const client = connect();
    await expect(writeReviewLater({ trackId: 4, trackName: "D" })).resolves.toBe("applied");
    expect(client.addTrackTags).toHaveBeenCalledWith([4], "review:later");
  });

  it("ホストがタグ未対応なら unsupported（退避するかは呼び出し側）", async () => {
    connect({ addTrackTags: jest.fn(async () => Promise.reject(new ApiError(404, "nope"))) });
    await expect(writeReviewLater({ trackId: 4 })).resolves.toBe("unsupported");
    expect(queuedOps()).toEqual([]);
  });

  it("オフラインは review-later としてキューに積んで queued", async () => {
    await expect(writeReviewLater({ trackId: 4, trackName: "D" })).resolves.toBe("queued");
    expect(queuedOps()).toEqual([{ kind: "review-later", trackId: 4, trackName: "D" }]);
  });

  it("queueReviewLater は接続中でも端末側のキューにだけ記録する", () => {
    const client = connect();
    queueReviewLater({ trackId: 5 });
    expect(client.addTrackTags).not.toHaveBeenCalled();
    expect(queuedOps()).toEqual([{ kind: "review-later", trackId: 5, trackName: null }]);
  });
});

describe("invalidateRatingQueries", () => {
  it("rating を含む一覧のキーをすべて無効化する", async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, "invalidateQueries");
    await invalidateRatingQueries(qc);
    expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["tracks"],
      ["artist-tracks"],
      ["album-tracks"],
      ["playlist-tracks"],
      ["similar"],
    ]);
    expect(RATING_AFFECTED_KEYS).toHaveLength(5);
    qc.clear();
  });
});
