// Library 画面のコンポーネントテスト。接続済み + URL ごとに応答を返す fetch モックで
// 描画し、曲タイトルが出ること・行タップで usePlayer.setQueue が呼ばれることを確認する。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

import { type Track, usePlayer } from "@crateforge/core";
import { setTestConnection, createQueryWrapper, resetTestState } from "@/test-utils";
import LibraryScreen from "@/app/(tabs)/index";

// SafeAreaProvider をテストツリーに張らずに insets を固定で返す。
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 42,
    persistentId: null,
    name: "Test Song",
    artist: "Test Artist",
    albumArtist: null,
    composer: null,
    album: "Test Album",
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

/** URL でルーティングする fetch モック（artists/tracks/genres/albums を返し分ける）。
 * useArtists は /api/artists を叩くようになったので artists も返し分ける。
 */
function mockFetchByUrl(tracks: Track[]): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = String(input);
    let body: unknown = [];
    if (url.includes("/api/artists")) body = [];
    else if (url.includes("/api/tracks")) body = tracks;
    else if (url.includes("/api/genres")) body = [{ tag: "House", count: 3 }];
    else if (url.includes("/api/albums")) body = [];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  resetTestState();
});

describe("LibraryScreen", () => {
  test("renders a track title and tapping a row updates the player queue", async () => {
    setTestConnection();
    const tracks = [
      makeTrack({ trackId: 11, name: "First Song" }),
      makeTrack({ trackId: 22, name: "Second Song" }),
    ];
    mockFetchByUrl(tracks);

    const setQueueSpy = jest.spyOn(usePlayer.getState(), "setQueue");

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

    // デフォルトはアルバムモードなので曲モードに切替える。
    fireEvent.press(screen.getByText("曲"));

    const row = await screen.findByText("Second Song");
    expect(screen.getByText("First Song")).toBeTruthy();

    fireEvent.press(row);

    await waitFor(() => {
      expect(setQueueSpy).toHaveBeenCalledTimes(1);
    });
    // 2 番目の曲を押したので index=1 でキュー化される
    expect(setQueueSpy).toHaveBeenCalledWith(tracks, 1);
    // ストアにも反映される
    expect(usePlayer.getState().current()?.trackId).toBe(22);
  });

  test("shows offline library with connect action when no client and no downloads", async () => {
    // 未接続かつ DL なし（resetTestState 済み）→ オフライン表示＋接続導線。
    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );
    expect(await screen.findByText("ダウンロード済みの曲はありません")).toBeTruthy();
    expect(screen.getByLabelText("サーバーに接続")).toBeTruthy();
  });
});
