// Browse フックのテスト。setTestConnection + mockFetch + createQueryWrapper で
// 接続済み状態を作り、フックがパース済みデータを返し正しい URL を叩くことを確認する。

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";

import {
  type Album,
  type GenreTagCount,
  type Playlist,
  type Track,
  BROWSE_LIMIT,
  artistTracksQuery,
  browseKeys,
  useAlbums as useAlbumsUnsorted,
} from "@crateforge/core";
import {
  createQueryWrapper,
  setTestConnection,
  mockFetch,
  resetTestState,
} from "@/test-utils";
import {
  useAlbumTracks,
  useAlbums,
  useArtistTracks,
  useArtists,
  useTracks,
  useGenres,
  usePlaylists,
  usePlaylistTracks,
} from "@/features/browse/hooks";

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

/** キャッシュの中身（queryKey）を確かめられるよう、QueryClient を外から持つラッパ。 */
function wrapperWithClient(staleTime = 0) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const keys = () =>
    qc
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
  return { qc, wrapper, keys };
}

describe("browseKeys（キャッシュ・永続化と同じ形を保つ）", () => {
  test("各キーの形", () => {
    expect(browseKeys.tracksRoot).toEqual(["tracks"]);
    expect(browseKeys.tracks()).toEqual(["tracks", {}]);
    expect(browseKeys.tracks({ q: "a", limit: 5 })).toEqual(["tracks", { q: "a", limit: 5 }]);
    expect(browseKeys.genres).toEqual(["genres"]);
    expect(browseKeys.playlists).toEqual(["playlists"]);
    expect(browseKeys.playlist(3)).toEqual(["playlist", 3]);
    expect(browseKeys.playlistTracksRoot).toEqual(["playlist-tracks"]);
    expect(browseKeys.playlistTracks(3)).toEqual(["playlist-tracks", 3]);
    expect(browseKeys.albums).toEqual(["albums"]);
    expect(browseKeys.albumTracksRoot).toEqual(["album-tracks"]);
    expect(browseKeys.albumTracks("Dawn")).toEqual(["album-tracks", "Dawn"]);
    expect(browseKeys.artistsRoot).toEqual(["artists"]);
    expect(browseKeys.artists("albumArtist")).toEqual(["artists", "albumArtist"]);
    expect(browseKeys.artistTracksRoot).toEqual(["artist-tracks"]);
    expect(browseKeys.artistTracks("artist", "ABBA")).toEqual(["artist-tracks", "artist", "ABBA"]);
    expect(browseKeys.similarRoot).toEqual(["similar"]);
    expect(browseKeys.similar(9)).toEqual(["similar", 9]);
  });

  test("BROWSE_LIMIT は 100000", () => {
    expect(BROWSE_LIMIT).toBe(100000);
  });

  test("フックは browseKeys のキーでキャッシュする", async () => {
    setTestConnection();
    mockFetch({ body: [] });
    const { wrapper, keys } = wrapperWithClient();
    await renderHook(
      () => {
        useTracks({ limit: 10, sort: "name", order: "asc" });
        usePlaylists();
        usePlaylistTracks(100);
        useAlbums();
        useAlbumTracks("Dawn");
        useArtists(true, "artist");
        useArtistTracks("ABBA", "albumArtist");
      },
      { wrapper },
    );
    expect(keys()).toEqual(
      expect.arrayContaining([
        ["tracks", { limit: 10, sort: "name", order: "asc" }],
        ["playlists"],
        ["playlist-tracks", 100],
        ["albums"],
        ["album-tracks", "Dawn"],
        ["artists", "artist"],
        ["artist-tracks", "albumArtist", "ABBA"],
      ]),
    );
    expect(keys()).toHaveLength(7);
  });
});

describe("useTracks の staleTime", () => {
  // 絞り込み無しの全曲取得だけ 5 分。それ以外は QueryClient の既定（アプリごとの値）に従う。
  async function staleAfterFetch(query: Parameters<typeof useTracks>[0]) {
    setTestConnection();
    mockFetch({ body: [] });
    const { wrapper } = wrapperWithClient(0);
    const { result } = await renderHook(() => useTracks(query), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    return result.current.isStale;
  }

  test("絞り込み無しは既定（0）より長く新鮮なまま", async () => {
    expect(await staleAfterFetch({ limit: BROWSE_LIMIT })).toBe(false);
  });

  test("検索・ジャンル絞り込みは既定の staleTime に従う", async () => {
    expect(await staleAfterFetch({ q: "abc" })).toBe(true);
    expect(await staleAfterFetch({ genre: "House" })).toBe(true);
  });
});

describe("usePlaylistTracks（id 無し）", () => {
  test("playlistId が null/undefined なら取得しない", async () => {
    setTestConnection();
    const fetchMock = mockFetch({ body: [] });
    const { result } = await renderHook(() => usePlaylistTracks(undefined), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useAlbumTracks", () => {
  test("albumExact で引き、完全一致で絞って disc→track 順に並べる", async () => {
    setTestConnection();
    const fetchMock = mockFetch({
      body: [
        makeTrack({ trackId: 1, album: "Dawn", discNumber: 2, trackNumber: 1 }),
        makeTrack({ trackId: 2, album: "Dawn (Remixes)", discNumber: 1, trackNumber: 1 }),
        makeTrack({ trackId: 3, album: "Dawn", discNumber: 1, trackNumber: 2 }),
        makeTrack({ trackId: 4, album: "Dawn", discNumber: 1, trackNumber: 1 }),
      ],
    });
    const { result } = await renderHook(() => useAlbumTracks("Dawn"), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((t) => t.trackId)).toEqual([4, 3, 1]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("album=Dawn");
    expect(url).toContain("albumExact=true");
    expect(url).toContain("limit=100000");
  });

  test("album が null なら取得しない", async () => {
    setTestConnection();
    const fetchMock = mockFetch({ body: [] });
    const { result } = await renderHook(() => useAlbumTracks(null), { wrapper: createQueryWrapper() });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useAlbums", () => {
  const albums: Album[] = [
    { album: "Zeta", albumArtist: "Alpha", trackCount: 1, sampleTrackId: 1 },
    { album: "", albumArtist: null, trackCount: 1, sampleTrackId: 2 },
    { album: "Beta", albumArtist: "Bravo", trackCount: 1, sampleTrackId: 3 },
    { album: "Alpha LP", albumArtist: "Alpha", trackCount: 1, sampleTrackId: 4 },
  ];

  test("core: select 無しなら API の順のまま、select を渡せばその結果", async () => {
    setTestConnection();
    mockFetch({ body: albums });
    const raw = await renderHook(() => useAlbumsUnsorted(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(raw.result.current.isSuccess).toBe(true));
    expect(raw.result.current.data?.map((a) => a.album)).toEqual(["Zeta", "", "Beta", "Alpha LP"]);

    const reversed = await renderHook(
      () => useAlbumsUnsorted({ select: (list) => [...list].reverse() }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(reversed.result.current.isSuccess).toBe(true));
    expect(reversed.result.current.data?.map((a) => a.album)).toEqual(["Alpha LP", "Beta", "", "Zeta"]);
  });

  test("core: enabled=false なら取得しない", async () => {
    setTestConnection();
    const fetchMock = mockFetch({ body: albums });
    const { result } = await renderHook(() => useAlbumsUnsorted({ enabled: false }), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("mobile: アルバムアーティスト（無ければアルバム名）→ アルバム名の順", async () => {
    setTestConnection();
    mockFetch({ body: albums });
    const { result } = await renderHook(() => useAlbums(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((a) => a.album)).toEqual(["", "Alpha LP", "Zeta", "Beta"]);
  });
});

describe("useArtistTracks", () => {
  test("artistTracksQuery は grouping に応じて artist / albumArtist で絞る", () => {
    expect(artistTracksQuery("ABBA", "artist")).toEqual({ artist: "ABBA", limit: BROWSE_LIMIT });
    expect(artistTracksQuery("ABBA", "albumArtist")).toEqual({ albumArtist: "ABBA", limit: BROWSE_LIMIT });
  });

  test("grouping=albumArtist なら ?albumArtist= で引く", async () => {
    setTestConnection();
    const fetchMock = mockFetch({ body: [makeTrack()] });
    const { result } = await renderHook(() => useArtistTracks("ABBA", "albumArtist"), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("albumArtist=ABBA");
    expect(url).not.toContain("&artist=");
  });

  test("artist が null なら取得しない", async () => {
    setTestConnection();
    const fetchMock = mockFetch({ body: [] });
    const { result } = await renderHook(() => useArtistTracks(null, "artist"), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
