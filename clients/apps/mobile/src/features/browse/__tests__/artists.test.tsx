// アーティストブラウズのテスト。
// useArtists のグルーピング確認と Library のアーティストモード切替テスト。
// useArtists は /api/artists に切り替え済み、useArtistTracks は /api/tracks?artist=... を使う。

import { renderHook, render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import { type Artist, type Track, usePlayer } from "@crateforge/core";
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

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    artist: "Test Artist",
    trackCount: 1,
    sampleTrackId: 42,
    ...overrides,
  };
}

/**
 * URL でルーティングする fetch モック。
 * useArtists は /api/artists を叩くようになったので、artists と tracks を返し分ける。
 */
function mockFetchByUrl(artists: Artist[], tracks: Track[] = []): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = String(input);
    let body: unknown = [];
    if (url.includes("/api/artists")) body = artists;
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
  (router.push as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

describe("useArtists", () => {
  test("fetches artists from /api/artists and returns correct data", async () => {
    setTestConnection();
    const artists: Artist[] = [
      makeArtist({ artist: "Artist A", trackCount: 2, sampleTrackId: 1 }),
      makeArtist({ artist: "Artist B", trackCount: 1, sampleTrackId: 3 }),
    ];
    mockFetchByUrl(artists);

    const wrapper = createQueryWrapper();
    const { result } = await renderHook(() => useArtists(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const data: Artist[] = result.current.data ?? [];
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

  test("passes grouping=albumArtist query param to /api/artists", async () => {
    setTestConnection();
    const artists: Artist[] = [
      makeArtist({ artist: "Various Artists", trackCount: 2, sampleTrackId: 1 }),
      makeArtist({ artist: "Solo Artist", trackCount: 1, sampleTrackId: 3 }),
    ];
    const fetchMock = mockFetchByUrl(artists);

    const wrapper = createQueryWrapper();
    const { result } = await renderHook(() => useArtists(true, "albumArtist"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const data: Artist[] = result.current.data ?? [];
    expect(data).toHaveLength(2);

    // サーバ集計を信頼する（クライアント側の集計ロジックはテスト不要）。
    expect(data.find((a) => a.artist === "Various Artists")).toBeDefined();
    expect(data.find((a) => a.artist === "Solo Artist")).toBeDefined();

    // grouping=albumArtist が URL に渡されること。
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/api/artists");
    expect(calledUrl).toContain("albumArtist");
  });
});

describe("Library artist mode", () => {
  test("artist mode is the default and shows artist names immediately", async () => {
    setTestConnection();
    const artists: Artist[] = [
      makeArtist({ artist: "Miles Davis", trackCount: 1, sampleTrackId: 11 }),
      makeArtist({ artist: "John Coltrane", trackCount: 1, sampleTrackId: 22 }),
    ];
    mockFetchByUrl(artists);

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

    // 既定がアーティストモードなので、トグルを押さずとも表示される。
    expect(await screen.findByText("Miles Davis")).toBeTruthy();
    expect(screen.getByText("John Coltrane")).toBeTruthy();
  });

  test("tapping an artist row navigates to the artist route", async () => {
    setTestConnection();
    const artists: Artist[] = [
      makeArtist({ artist: "Miles Davis", trackCount: 1, sampleTrackId: 11 }),
    ];
    mockFetchByUrl(artists);

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

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
    // ArtistScreen は useArtistTracks（/api/tracks?artist=...）を使う。
    // useArtistAlbums も同じクエリキーなので /api/tracks が返せば両方満たせる。
    mockFetchByUrl([], tracks);

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

  test("album が空の曲は『アルバム』セクションに行を作らない（/album/ への遷移クラッシュ防止）", async () => {
    setTestConnection();
    (useLocalSearchParams as jest.Mock).mockReturnValue({ name: encodeURIComponent("Miles Davis") });
    // 1 曲は実アルバム、1 曲はアルバム無し（album: null）。
    const tracks = [
      makeTrack({ trackId: 301, name: "Real Album Song", artist: "Miles Davis", album: "Kind of Blue" }),
      makeTrack({ trackId: 302, name: "No Album Song", artist: "Miles Davis", album: null }),
    ];
    mockFetchByUrl([], tracks);

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <ArtistScreen />
      </Wrapper>,
    );

    // 実アルバムはアルバムセクションに出る。
    expect(await screen.findByText("Kind of Blue")).toBeTruthy();
    // アルバム枚数は 1（空アルバムは含めない）。
    expect(screen.getByText("1枚のアルバム ・ 2曲")).toBeTruthy();
    // 無アルバム曲は「全曲」セクションからアクセスできる。
    expect(screen.getByText("No Album Song")).toBeTruthy();
  });
});
