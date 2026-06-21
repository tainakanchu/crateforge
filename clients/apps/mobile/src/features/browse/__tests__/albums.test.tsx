// アルバムブラウズのテスト。Library を「アルバム」モードに切替えてアルバム名が出ること、
// 行タップで album ルートへ遷移すること、アルバム詳細で曲が出て「再生」で setQueue されることを確認する。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import { type Album, type Track, usePlayer } from "@crateforge/core";
import { setTestConnection, createQueryWrapper, resetTestState, mockFetch } from "@/test-utils";
import LibraryScreen from "@/app/(tabs)/index";
import AlbumScreen from "@/app/album/[name]";

// SafeAreaProvider を張らずに insets を固定で返す。
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

/** URL でルーティングする fetch モック（albums/tracks/genres を返し分ける）。 */
function mockFetchByUrl(albums: Album[], tracks: Track[] = []): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = String(input);
    let body: unknown = [];
    if (url.includes("/api/albums")) body = albums;
    else if (url.includes("/api/tracks")) body = tracks;
    else if (url.includes("/api/genres")) body = [{ tag: "House", count: 3 }];
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
  (router.push as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

describe("Library album mode", () => {
  test("switching to album mode lists albums and tapping navigates to the album route", async () => {
    setTestConnection();
    const albums: Album[] = [
      { album: "Blue Train", albumArtist: "John Coltrane", trackCount: 5, sampleTrackId: 11 },
      { album: "Kind of Blue", albumArtist: "Miles Davis", trackCount: 6, sampleTrackId: 22 },
    ];
    mockFetchByUrl(albums);

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

    // 「アルバム」トグルに切替える。
    fireEvent.press(screen.getByText("アルバム"));

    const row = await screen.findByText("Blue Train");
    expect(screen.getByText("Kind of Blue")).toBeTruthy();

    fireEvent.press(row);

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/album/Blue%20Train");
    });
  });

  test("album search filters the list client-side", async () => {
    setTestConnection();
    const albums: Album[] = [
      { album: "Blue Train", albumArtist: "John Coltrane", trackCount: 5, sampleTrackId: 11 },
      { album: "Kind of Blue", albumArtist: "Miles Davis", trackCount: 6, sampleTrackId: 22 },
    ];
    mockFetchByUrl(albums);

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

    fireEvent.press(screen.getByText("アルバム"));
    await screen.findByText("Blue Train");

    fireEvent.changeText(screen.getByLabelText("検索"), "kind");

    await waitFor(() => {
      expect(screen.queryByText("Blue Train")).toBeNull();
    });
    expect(screen.getByText("Kind of Blue")).toBeTruthy();
  });
});

describe("AlbumScreen", () => {
  test("renders album tracks and play-all sets the queue from index 0", async () => {
    setTestConnection();
    (useLocalSearchParams as jest.Mock).mockReturnValue({ name: encodeURIComponent("Blue Train") });
    const tracks = [
      makeTrack({ trackId: 101, name: "Moments Notice", album: "Blue Train" }),
      makeTrack({ trackId: 102, name: "Locomotion", album: "Blue Train" }),
    ];
    mockFetch({ body: tracks });

    const setQueueSpy = jest.spyOn(usePlayer.getState(), "setQueue");

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <AlbumScreen />
      </Wrapper>,
    );

    expect(await screen.findByText("Moments Notice")).toBeTruthy();
    expect(screen.getByText("Locomotion")).toBeTruthy();
    // ヘッダにアルバム名（デコード済み）が出る。
    expect(screen.getByText("Blue Train")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("再生"));

    await waitFor(() => {
      expect(setQueueSpy).toHaveBeenCalledWith(tracks, 0);
    });
    expect(usePlayer.getState().current()?.trackId).toBe(101);
  });
});
