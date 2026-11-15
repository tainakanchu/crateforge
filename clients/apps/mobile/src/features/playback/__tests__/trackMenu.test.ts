// 曲メニューのトリアージ（評価 / タグ / あとで聴く）が API・pending キューへ
// `trackId` を渡すことの回帰テスト。`id`（デスクトップの内部行 id）を送ると別の曲に書き込まれていた。

import * as SecureStore from "expo-secure-store";

import { ApiClient, type Track } from "@crateforge/core";
import { useActionSheet } from "@/components/ActionSheet";
import { showRateMenu, showTrackMenu } from "@/features/playback/trackMenu";
import { usePendingEdits } from "@/store/pendingEdits";
import { resetTestState, setTestConnection } from "@/test-utils";

/** id（行 id）と trackId が食い違う曲。 */
function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 42,
    persistentId: null,
    name: "Test Song",
    artist: "Test Artist",
    albumArtist: null,
    composer: null,
    album: null,
    genre: null,
    year: null,
    rating: null,
    playCount: null,
    skipCount: null,
    totalTimeMs: null,
    dateAdded: null,
    dateModified: null,
    bpm: null,
    comments: null,
    locationRaw: null,
    locationPath: null,
    trackType: null,
    disabled: false,
    compilation: false,
    discNumber: null,
    discCount: null,
    trackNumber: null,
    trackCount: null,
    fileExists: true,
    lastPlayed: null,
    ...overrides,
  };
}

/** 表示中のアクションシートから label のボタンを押す（非同期の書き込みも待つ）。 */
async function press(label: string): Promise<void> {
  const action = useActionSheet.getState().current?.actions.find((a) => a.label === label);
  expect(action).toBeTruthy();
  action!.onPress?.();
  // onPress は `void applyX()` なので、マイクロタスクを流して完了を待つ。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetTestState();
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  useActionSheet.setState({ current: null });
  usePendingEdits.setState({ ops: [], conflicts: [], flushing: false, hydrated: true });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("曲メニューのトリアージは trackId で書き込む", () => {
  test("オンライン: 評価は setRating(trackId) を呼ぶ（id ではない）", async () => {
    setTestConnection();
    const setRating = jest.spyOn(ApiClient.prototype, "setRating").mockResolvedValue(undefined);
    showRateMenu(makeTrack());
    await press("★★★★");
    expect(setRating).toHaveBeenCalledWith(42, 80);
  });

  test("オンライン: タグ / あとで聴くは addTrackTags([trackId]) を呼ぶ", async () => {
    setTestConnection();
    const addTags = jest.spyOn(ApiClient.prototype, "addTrackTags").mockResolvedValue({ updated: 1 });
    showTrackMenu(makeTrack());
    await press("あとで聴く");
    expect(addTags).toHaveBeenCalledTimes(1);
    expect(addTags.mock.calls[0][0]).toEqual([42]);
  });

  test("オフライン: pending キューにも trackId を積む", async () => {
    showRateMenu(makeTrack());
    await press("★★★★");
    showTrackMenu(makeTrack());
    await press("あとで聴く");
    const ops = usePendingEdits.getState().ops;
    expect(ops.map((op) => op.kind)).toEqual(["rating", "review-later"]);
    expect(ops.every((op) => op.trackId === 42)).toBe(true);
  });
});
