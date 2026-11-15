// 長押しメニューのトリアージ操作（評価 / タグ / あとで聴く）の結果表示テスト。
// 書き込み自体は features/triage/edits.ts（edits.test.ts）。ここはメニュー側のトーストを固定する。

import { ApiClient, ApiError, type Track, useConnection } from "@crateforge/core";

import { useActionSheet } from "@/components/ActionSheet";
import { useToast } from "@/components/Toast";
import { usePendingEdits } from "@/store/pendingEdits";
import { showRateMenu, showTrackMenu } from "../trackMenu";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 11,
    trackId: 1011,
    name: "Song A",
    artist: "Artist",
    album: "Album",
    rating: 40,
    ...overrides,
  } as Track;
}

function connect(overrides: Partial<ApiClient> = {}): ApiClient {
  const client = {
    setRating: jest.fn(async () => undefined),
    addTrackTags: jest.fn(async () => ({ updated: 1 })),
    ...overrides,
  } as unknown as ApiClient;
  useConnection.setState({ client, status: "connected" });
  return client;
}

/** いま開いているアクションシートから label の項目を押し、非同期処理を流す。 */
async function press(label: string) {
  const action = useActionSheet.getState().current?.actions.find((a) => a.label === label);
  expect(action).toBeTruthy();
  action!.onPress?.();
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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

describe("長押しメニュー: 評価", () => {
  it("オンライン: 半星で保存してトースト", async () => {
    const client = connect();
    showRateMenu(makeTrack());
    await press("★★★½");
    expect(client.setRating).toHaveBeenCalledWith(11, 70);
    expect(toast()).toEqual({ message: "評価を保存しました（★★★½）", kind: "info" });
  });

  it("オンライン: クリア", async () => {
    const client = connect();
    showRateMenu(makeTrack());
    await press("クリア");
    expect(client.setRating).toHaveBeenCalledWith(11, 0);
    expect(toast().message).toBe("評価をクリアしました");
  });

  it("オンライン: 失敗は理由つきのエラートースト", async () => {
    connect({ setRating: jest.fn(async () => Promise.reject(new ApiError(500, "HTTP 500"))) });
    showRateMenu(makeTrack());
    await press("★★★★★");
    expect(toast().kind).toBe("error");
    expect(toast().message).toMatch(/^評価を保存できませんでした（.+）$/);
    expect(queuedKinds()).toEqual([]);
  });

  it("オフライン: キューに積んで同期予告のトースト", async () => {
    showRateMenu(makeTrack());
    await press("★★★★");
    expect(toast()).toEqual({ message: "オフライン: 再接続時に評価を同期します", kind: "info" });
    expect(usePendingEdits.getState().ops[0]).toMatchObject({
      kind: "rating",
      trackId: 11,
      rating: 80,
      baseRating: 40,
      trackName: "Song A",
    });
  });
});

describe("長押しメニュー: タグ / あとで聴く", () => {
  async function openTagMenu() {
    showTrackMenu(makeTrack());
    await press("タグを付ける…");
  }

  it("オンライン: タグを付けてトースト", async () => {
    const client = connect();
    await openTagMenu();
    await press("mood:chill");
    expect(client.addTrackTags).toHaveBeenCalledWith([11], "mood:chill");
    expect(toast()).toEqual({ message: "タグを付けました", kind: "info" });
  });

  it("オンライン: ホスト未対応はエラートースト（キューに積まない）", async () => {
    connect({ addTrackTags: jest.fn(async () => Promise.reject(new ApiError(404, "nope"))) });
    await openTagMenu();
    await press("mood:chill");
    expect(toast()).toEqual({
      message: "このデスクトップはタグ機能に未対応です（アプリを更新してください）",
      kind: "error",
    });
    expect(queuedKinds()).toEqual([]);
  });

  it("オンライン: それ以外の失敗は理由つきのエラートースト", async () => {
    connect({ addTrackTags: jest.fn(async () => Promise.reject(new ApiError(500, "HTTP 500"))) });
    await openTagMenu();
    await press("mood:chill");
    expect(toast().kind).toBe("error");
    expect(toast().message).toMatch(/^タグを付けられませんでした（.+）$/);
  });

  it("オフライン: tag-add としてキューに積む", async () => {
    await openTagMenu();
    await press("mood:chill");
    expect(toast().message).toBe("オフライン: 再接続時にタグを同期します");
    expect(queuedKinds()).toEqual(["tag-add"]);
  });

  it("あとで聴く: オンラインは review:later タグ", async () => {
    const client = connect();
    showTrackMenu(makeTrack());
    await press("あとで聴く");
    expect(client.addTrackTags).toHaveBeenCalledWith([11], "review:later");
    expect(toast().message).toBe("「あとで聴く」に追加しました");
  });

  it("あとで聴く: ホスト未対応なら端末側のキューに退避する", async () => {
    connect({ addTrackTags: jest.fn(async () => Promise.reject(new ApiError(501, "nope"))) });
    showTrackMenu(makeTrack());
    await press("あとで聴く");
    expect(toast()).toEqual({ message: "デスクトップ未対応のため、端末側のみに記録しました", kind: "info" });
    expect(queuedKinds()).toEqual(["review-later"]);
  });

  it("あとで聴く: それ以外の失敗はエラートースト", async () => {
    connect({ addTrackTags: jest.fn(async () => Promise.reject(new ApiError(500, "HTTP 500"))) });
    showTrackMenu(makeTrack());
    await press("あとで聴く");
    expect(toast().kind).toBe("error");
    expect(toast().message).toMatch(/^記録できませんでした（.+）$/);
    expect(queuedKinds()).toEqual([]);
  });

  it("あとで聴く: オフラインは review-later としてキューに積む", async () => {
    showTrackMenu(makeTrack());
    await press("あとで聴く");
    expect(toast().message).toBe("オフライン: 再接続時に「あとで聴く」を同期します");
    expect(queuedKinds()).toEqual(["review-later"]);
  });
});
