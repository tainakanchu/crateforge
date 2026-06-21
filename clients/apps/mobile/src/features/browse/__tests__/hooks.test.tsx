// Browse フックのテスト。setTestConnection + mockFetch + createQueryWrapper で
// 接続済み状態を作り、フックがパース済みデータを返し正しい URL を叩くことを確認する。

import { renderHook, waitFor } from "@testing-library/react-native";

import { type GenreTagCount, type Playlist, type Track } from "@crateforge/core";
import {
  createQueryWrapper,
  setTestConnection,
  mockFetch,
  resetTestState,
} from "@/test-utils";
import { useTracks, useGenres, usePlaylists, usePlaylistTracks } from "@/features/browse/hooks";

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

beforeEach(() => {
  resetTestState();
});

describe("useTracks", () => {
  test("returns parsed tracks and queries /api/tracks with q & genre", async () => {
    setTestConnection({ baseUrl: "http://host:8787", token: "tok" });
    const fetchMock = mockFetch({ body: [makeTrack({ name: "Hello" })] });

    const { result } = await renderHook(() => useTracks({ q: "hello", genre: "House" }), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.name).toBe("Hello");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/tracks");
    expect(url).toContain("q=hello");
    expect(url).toContain("genre=House");
  });

  test("is disabled (no fetch) when not connected", async () => {
    const fetchMock = mockFetch({ body: [] });
    const { result } = await renderHook(() => useTracks(), { wrapper: createQueryWrapper() });
    // enabled:false なので fetch しない
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useGenres", () => {
  test("returns genre tag counts from /api/genres", async () => {
    setTestConnection();
    const genres: GenreTagCount[] = [
      { tag: "House", count: 12 },
      { tag: "Techno", count: 8 },
    ];
    const fetchMock = mockFetch({ body: genres });

    const { result } = await renderHook(() => useGenres(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(genres);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/genres");
  });
});

describe("usePlaylists", () => {
  test("returns playlists from /api/playlists", async () => {
    setTestConnection();
    const playlists: Playlist[] = [
      {
        id: 1,
        playlistId: 100,
        persistentId: null,
        parentPersistentId: null,
        name: "My List",
        isFolder: false,
        isSmart: false,
        isUserCreated: true,
        trackCount: 3,
      },
    ];
    const fetchMock = mockFetch({ body: playlists });

    const { result } = await renderHook(() => usePlaylists(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe("My List");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/playlists");
  });
});

describe("usePlaylistTracks", () => {
  test("queries /api/playlists/{id}/tracks and returns tracks", async () => {
    setTestConnection();
    const fetchMock = mockFetch({ body: [makeTrack({ trackId: 7, name: "InList" })] });

    const { result } = await renderHook(() => usePlaylistTracks(100), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe("InList");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/playlists/100/tracks");
  });
});
