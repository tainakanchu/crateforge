// アーティストブラウズのテスト。
// useArtists のグルーピング確認と Library のアーティストモード切替テスト。

import { renderHook, render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import { type Track, usePlayer } from "@crateforge/core";
import { setTestConnection, createQueryWrapper, resetTestState } from "@/test-utils";
import { useArtists } from "@/features/browse/hooks";
import LibraryScreen from "@/app/(tabs)/index";
import ArtistScreen from "@/app/artist/[name]";

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

/** URL でルーティングする fetch モック。 */
function mockFetchByUrl(tracks: Track[]): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = String(input);
    let body: unknown = [];
    if (url.includes("/api/tracks")) body = tracks;
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
  (router.push as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

describe("useArtists", () => {
  test("groups tracks by artist and returns correct trackCount", async () => {
    setTestConnection();
    const tracks = [
      makeTrack({ trackId: 1, artist: "Artist A", name: "Song 1" }),
      makeTrack({ trackId: 2, artist: "Artist A", name: "Song 2" }),
      makeTrack({ trackId: 3, artist: "Artist B", name: "Song 3" }),
    ];
    mockFetchByUrl(tracks);

    const wrapper = createQueryWrapper();
    const { result } = await renderHook(() => useArtists(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const data: import("@crateforge/core").Artist[] = result.current.data ?? [];
    expect(data).toHaveLength(2);

    const artistA = data.find((a) => a.artist === "Artist A");
    const artistB = data.find((a) => a.artist === "Artist B");

    expect(artistA).toBeDefined();
    expect(artistA?.trackCount).toBe(2);
    expect(artistA?.sampleTrackId).toBe(1);

    expect(artistB).toBeDefined();
    expect(artistB?.trackCount).toBe(1);
    expect(artistB?.sampleTrackId).toBe(3);
  });
});

describe("Library artist mode", () => {
  test("switching to artist mode shows artist names", async () => {
    setTestConnection();
    const tracks = [
      makeTrack({ trackId: 11, artist: "Miles Davis", name: "Kind of Blue" }),
      makeTrack({ trackId: 22, artist: "John Coltrane", name: "Blue Train" }),
    ];
    mockFetchByUrl(tracks);

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

    // 「アーティスト」トグルを押す。
    fireEvent.press(screen.getByText("アーティスト"));

    expect(await screen.findByText("Miles Davis")).toBeTruthy();
    expect(screen.getByText("John Coltrane")).toBeTruthy();
  });

  test("tapping an artist row navigates to the artist route", async () => {
    setTestConnection();
    const tracks = [
      makeTrack({ trackId: 11, artist: "Miles Davis", name: "Kind of Blue" }),
    ];
    mockFetchByUrl(tracks);

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

    fireEvent.press(screen.getByText("アーティスト"));
    const row = await screen.findByText("Miles Davis");
    fireEvent.press(row);

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/artist/Miles%20Davis");
    });
  });
});

describe("ArtistScreen", () => {
  test("renders artist tracks and play-all sets the queue from index 0", async () => {
    setTestConnection();
    (useLocalSearchParams as jest.Mock).mockReturnValue({ name: encodeURIComponent("Miles Davis") });
    const tracks = [
      makeTrack({ trackId: 201, name: "So What", artist: "Miles Davis" }),
      makeTrack({ trackId: 202, name: "Freddie Freeloader", artist: "Miles Davis" }),
    ];
    mockFetchByUrl(tracks);

    const setQueueSpy = jest.spyOn(usePlayer.getState(), "setQueue");

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <ArtistScreen />
      </Wrapper>,
    );

    expect(await screen.findByText("So What")).toBeTruthy();
    expect(screen.getByText("Freddie Freeloader")).toBeTruthy();
    expect(screen.getByText("Miles Davis")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("再生"));

    await waitFor(() => {
      expect(setQueueSpy).toHaveBeenCalledWith(tracks, 0);
    });
    expect(usePlayer.getState().current()?.trackId).toBe(201);
  });
});
