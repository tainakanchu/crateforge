// 不明なアーティスト / 不明なアルバム（タグに無い曲のグループ）のテスト。
// デスクトップの API は空のアーティスト / アルバムを `artist: ""` / `album: ""` の 1 グループで返す。
// モバイルは「不明なアーティスト」/「不明なアルバム」と表示し、空名でも詳細へ遷移できること
// （expo-router の [name] は空にできないので `_?unknown=1`）、詳細が空名で正しく曲を引くことを確認する。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import { type Album, type Artist, type Track } from "@crateforge/core";
import { setTestConnection, createQueryWrapper, resetTestState } from "@/test-utils";
import LibraryScreen from "@/app/(tabs)/index";
import ArtistScreen from "@/app/artist/[name]";
import AlbumScreen from "@/app/album/[name]";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 42,
    persistentId: null,
    name: "Test Song",
    artist: null,
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

/** URL でルーティングする fetch モック。呼ばれた URL は mock.calls から確認する。 */
function mockFetchByUrl(opts: { artists?: Artist[]; albums?: Album[]; tracks?: Track[] }): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = String(input);
    let body: unknown = [];
    if (url.includes("/api/artists")) body = opts.artists ?? [];
    else if (url.includes("/api/albums")) body = opts.albums ?? [];
    else if (url.includes("/api/tracks")) body = opts.tracks ?? [];
    else if (url.includes("/api/genres")) body = [];
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

function calledUrls(fn: jest.Mock): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  resetTestState();
  (router.push as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

describe("Library: 不明なアーティスト / アルバム", () => {
  test("空名のアーティストは「不明なアーティスト」と表示され末尾に並び、タップで unknown ルートへ", async () => {
    setTestConnection();
    mockFetchByUrl({
      artists: [
        { artist: "", trackCount: 3, sampleTrackId: 9 },
        { artist: "Zeta", trackCount: 1, sampleTrackId: 2 },
        { artist: "Alpha", trackCount: 1, sampleTrackId: 1 },
      ],
    });
    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );

    const unknown = await screen.findByText("不明なアーティスト");
    // 末尾: Alpha → Zeta → 不明なアーティスト。
    const names = screen
      .getAllByText(/^(Alpha|Zeta|不明なアーティスト)$/)
      .map((n) => n.props.children);
    expect(names).toEqual(["Alpha", "Zeta", "不明なアーティスト"]);

    fireEvent.press(unknown);
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/artist/_?unknown=1");
    });
  });

  test("検索は表示ラベルで照合する（「不明」で不明なアーティストが残る）", async () => {
    setTestConnection();
    mockFetchByUrl({
      artists: [
        { artist: "", trackCount: 3, sampleTrackId: 9 },
        { artist: "Alpha", trackCount: 1, sampleTrackId: 1 },
      ],
    });
    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );
    await screen.findByText("不明なアーティスト");

    fireEvent.changeText(screen.getByLabelText("検索"), "不明");
    await waitFor(() => {
      expect(screen.queryByText("Alpha")).toBeNull();
    });
    expect(screen.getByText("不明なアーティスト")).toBeTruthy();
  });

  test("空名のアルバムは「不明なアルバム」と表示され、タップで unknown ルートへ", async () => {
    setTestConnection();
    mockFetchByUrl({
      albums: [
        { album: "", albumArtist: null, trackCount: 4, sampleTrackId: 9 },
        { album: "Blue Train", albumArtist: "John Coltrane", trackCount: 5, sampleTrackId: 11 },
      ],
    });
    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <LibraryScreen />
      </Wrapper>,
    );
    fireEvent.press(screen.getByText("アルバム"));

    const unknown = await screen.findByText("不明なアルバム");
    fireEvent.press(unknown);
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/album/_?unknown=1");
    });
  });
});

describe("詳細画面: 空名のグループ", () => {
  test("不明なアーティスト: /api/tracks?artist=（空）で引き、見出しは「不明なアーティスト」", async () => {
    setTestConnection();
    (useLocalSearchParams as jest.Mock).mockReturnValue({ name: "_", unknown: "1" });
    const tracks = [
      makeTrack({ trackId: 1, name: "01 Untitled" }),
      makeTrack({ trackId: 2, name: "02 Untitled", album: "Some Album" }),
    ];
    const fetchMock = mockFetchByUrl({ tracks });

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <ArtistScreen />
      </Wrapper>,
    );

    expect(await screen.findByText("01 Untitled")).toBeTruthy();
    expect(screen.getByText("02 Untitled")).toBeTruthy();
    // 見出し（不明なアーティスト。曲行のサブタイトルにも出る）と、アルバム一覧の「不明なアルバム」グループ。
    expect(screen.getAllByText("不明なアーティスト").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("不明なアルバム")).toBeTruthy();
    // "Some Album" はアルバム行と曲行のサブタイトルの両方に出る。
    expect(screen.getAllByText("Some Album").length).toBeGreaterThanOrEqual(1);
    // 空名でもサーバ側フィルタ（artist=）で取得している。"_" という名前では引いていない。
    const urls = calledUrls(fetchMock).filter((u) => u.includes("/api/tracks"));
    expect(urls.some((u) => /[?&]artist=(&|$)/.test(u))).toBe(true);
    expect(urls.some((u) => u.includes("artist=_"))).toBe(false);

    // 不明なアルバムをタップ → このアーティスト（空名）の無アルバム曲の表示へ。
    fireEvent.press(screen.getByText("不明なアルバム"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/album/none?noAlbum=1&artist=&grouping=artist");
    });
  });

  test("不明なアルバム: /api/tracks?album=&albumExact=true で引き、album が空の曲だけを出す", async () => {
    setTestConnection();
    (useLocalSearchParams as jest.Mock).mockReturnValue({ name: "_", unknown: "1" });
    const tracks = [
      makeTrack({ trackId: 1, name: "No Album A", artist: "Alpha" }),
      makeTrack({ trackId: 2, name: "No Album B", album: "" }),
      // 古いホストが完全一致に対応していなくてもクライアント側で落とす。
      makeTrack({ trackId: 3, name: "Has Album", album: "Real" }),
    ];
    const fetchMock = mockFetchByUrl({ tracks });

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <AlbumScreen />
      </Wrapper>,
    );

    expect(await screen.findByText("No Album A")).toBeTruthy();
    expect(screen.getByText("No Album B")).toBeTruthy();
    expect(screen.queryByText("Has Album")).toBeNull();
    expect(screen.getByText("不明なアルバム")).toBeTruthy();
    const urls = calledUrls(fetchMock).filter((u) => u.includes("/api/tracks"));
    expect(urls.some((u) => /[?&]album=&/.test(u) && u.includes("albumExact=true"))).toBe(true);
  });

  test("不明なアーティストの不明なアルバム（noAlbum + artist 空）も取得して表示する", async () => {
    setTestConnection();
    (useLocalSearchParams as jest.Mock).mockReturnValue({
      name: "none",
      noAlbum: "1",
      artist: "",
      grouping: "artist",
    });
    const tracks = [
      makeTrack({ trackId: 1, name: "Loose Track" }),
      makeTrack({ trackId: 2, name: "Album Track", album: "Real" }),
    ];
    const fetchMock = mockFetchByUrl({ tracks });

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <AlbumScreen />
      </Wrapper>,
    );

    expect(await screen.findByText("Loose Track")).toBeTruthy();
    expect(screen.queryByText("Album Track")).toBeNull();
    expect(screen.getByText("不明なアルバム")).toBeTruthy();
    const urls = calledUrls(fetchMock).filter((u) => u.includes("/api/tracks"));
    expect(urls.some((u) => /[?&]artist=(&|$)/.test(u))).toBe(true);
  });
});
