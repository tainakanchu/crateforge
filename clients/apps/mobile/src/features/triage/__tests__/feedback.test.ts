// 評価・タグ書き込みの失敗 / 未対応トースト（プレイヤーと長押しメニューで共通）のテスト。

import { ApiClient, ApiError, useConnection } from "@crateforge/core";

import { useToast } from "@/components/Toast";
import { usePendingEdits } from "@/store/pendingEdits";
import { addTagWithFeedback, rateWithFeedback, reportRatingFailure } from "../feedback";

function connect(overrides: Partial<ApiClient> = {}): ApiClient {
  const client = {
    setRating: jest.fn(async () => undefined),
    addTrackTags: jest.fn(async () => ({ updated: 1 })),
    ...overrides,
  } as unknown as ApiClient;
  useConnection.setState({ client, status: "connected" });
  return client;
}

const failing = (status: number) => jest.fn(async () => Promise.reject(new ApiError(status, `HTTP ${status}`)));

const toast = () => {
  const { message, kind } = useToast.getState();
  return { message, kind };
};

const queuedKinds = () => usePendingEdits.getState().ops.map((o) => o.kind);

beforeEach(() => {
  useConnection.setState({ client: null, status: "idle" });
  usePendingEdits.setState({ ops: [], conflicts: [], flushing: false, hydrated: true });
  useToast.setState({ message: null, kind: "info" });
});

describe("評価", () => {
  it("reportRatingFailure は理由つきのエラートースト（プレイヤーの星の onError で使う）", () => {
    reportRatingFailure(new ApiError(500, "HTTP 500"));
    expect(toast().kind).toBe("error");
    expect(toast().message).toMatch(/^評価を保存できませんでした（.+）$/);
  });

  it("rateWithFeedback: 失敗は同じトーストを出して failed（投げない）", async () => {
    connect({ setRating: failing(500) });
    await expect(rateWithFeedback({ trackId: 1, rating: 80 })).resolves.toBe("failed");
    expect(toast().message).toMatch(/^評価を保存できませんでした（.+）$/);
  });

  it("rateWithFeedback: 成功・オフラインではトーストを出さない", async () => {
    connect();
    await expect(rateWithFeedback({ trackId: 1, rating: 80 })).resolves.toBe("applied");
    useConnection.setState({ client: null });
    await expect(rateWithFeedback({ trackId: 1, rating: 60 })).resolves.toBe("queued");
    expect(toast().message).toBeNull();
  });
});

describe("タグ", () => {
  it("失敗は理由つきのエラートーストを出して failed", async () => {
    connect({ addTrackTags: failing(500) });
    await expect(addTagWithFeedback({ trackId: 1, tag: "mood:chill" })).resolves.toBe("failed");
    expect(toast().kind).toBe("error");
    expect(toast().message).toMatch(/^タグを付けられませんでした（.+）$/);
    expect(queuedKinds()).toEqual([]);
  });

  it.each([404, 501])("デスクトップ未対応 (%d) はエラートーストを出して unsupported", async (status) => {
    connect({ addTrackTags: failing(status) });
    await expect(addTagWithFeedback({ trackId: 1, tag: "mood:chill" })).resolves.toBe("unsupported");
    expect(toast()).toEqual({
      message: "このデスクトップはタグ機能に未対応です（アプリを更新してください）",
      kind: "error",
    });
    expect(queuedKinds()).toEqual([]);
  });

  it("成功・オフラインではトーストを出さない", async () => {
    connect();
    await expect(addTagWithFeedback({ trackId: 1, tag: "mood:chill" })).resolves.toBe("applied");
    useConnection.setState({ client: null });
    await expect(addTagWithFeedback({ trackId: 1, tag: "mood:chill" })).resolves.toBe("queued");
    expect(toast().message).toBeNull();
    expect(queuedKinds()).toEqual(["tag-add"]);
  });
});

describe("あとで聴く（review:later）", () => {
  const edit = { trackId: 2, tag: "review:later", trackName: "Song" };

  it("失敗は「記録できませんでした」のエラートースト", async () => {
    connect({ addTrackTags: failing(500) });
    await expect(addTagWithFeedback(edit)).resolves.toBe("failed");
    expect(toast().kind).toBe("error");
    expect(toast().message).toMatch(/^記録できませんでした（.+）$/);
    expect(queuedKinds()).toEqual([]);
  });

  it("デスクトップ未対応なら端末側のキューに記録して知らせる", async () => {
    connect({ addTrackTags: failing(404) });
    await expect(addTagWithFeedback(edit)).resolves.toBe("unsupported");
    expect(toast()).toEqual({ message: "デスクトップがタグに未対応のため、端末に保留しました（次の同期でも未対応なら破棄されます）", kind: "info" });
    expect(queuedKinds()).toEqual(["review-later"]);
  });

  it("オフラインは review-later としてキューに積む", async () => {
    await expect(addTagWithFeedback(edit)).resolves.toBe("queued");
    expect(queuedKinds()).toEqual(["review-later"]);
  });
});
