// ダウンロード失敗の保持とアルバム完全一致（Round 1: B5/B9）。

import { File } from "expo-file-system";

import { type Track, useDownloads, useSettings } from "@crateforge/core";
import { mockFetch, resetTestState, setTestConnection } from "@/test-utils";

const downloadFileAsync = File.downloadFileAsync as jest.Mock;

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 100,
    persistentId: null,
    name: "Song",
    artist: "Artist",
    albumArtist: null,
    composer: null,
    album: "My Album",
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
    locationPath: "/music/song.mp3",
    trackType: null,
    disabled: false,
    compilation: false,
    discNumber: null,
    discCount: null,
    trackNumber: null,
    trackCount: null,
    fileExists: true,
    lastPlayed: null,
    ...over,
  };
}

beforeEach(() => {
  resetTestState();
  useDownloads.setState({ entries: {}, downloading: {}, failed: {}, lastFailure: null, playlists: {} });
  downloadFileAsync.mockClear();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ダウンロード失敗の保持（B9）", () => {
  it("失敗した曲を failed / lastFailure に残し、再試行で成功すると消える", async () => {
    setTestConnection({ token: "tok" });
    const track = makeTrack({ trackId: 7, name: "Broken" });
    downloadFileAsync.mockRejectedValueOnce(new Error("HTTP 400"));

    await useDownloads.getState().downloadTrack(track);

    let st = useDownloads.getState();
    expect(st.isDownloaded(7)).toBe(false);
    expect(st.downloading[7]).toBeUndefined();
    expect(st.failed[7]?.label).toBe("Broken");
    expect(st.failed[7]?.message).toMatch(/^ダウンロードに失敗しました: /);
    expect(st.lastFailure?.trackId).toBe(7);

    await useDownloads.getState().retryFailed();
    st = useDownloads.getState();
    expect(st.isDownloaded(7)).toBe(true);
    expect(st.failed[7]).toBeUndefined();
  });

  it("未接続でのダウンロードも失敗として記録する", async () => {
    await useDownloads.getState().downloadTrack(makeTrack({ trackId: 8 }));
    expect(useDownloads.getState().failed[8]?.message).toMatch(/接続していない/);
  });

  it("clearFailures で消える", async () => {
    await useDownloads.getState().downloadTrack(makeTrack({ trackId: 9 }));
    useDownloads.getState().clearFailures(9);
    expect(useDownloads.getState().failed[9]).toBeUndefined();
    useDownloads.getState().clearFailures();
    expect(useDownloads.getState().lastFailure).toBeNull();
  });

  it("原本ダウンロード URL は original=true&native=true（B1 と同根の 400 を避ける）", async () => {
    setTestConnection({ token: "tok" });
    useSettings.setState({ downloadQuality: "original" });
    await useDownloads.getState().downloadTrack(makeTrack({ trackId: 10 }));
    const url = String((downloadFileAsync.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("original=true");
    expect(url).toContain("native=true");
    expect(url).not.toMatch(/=1(&|$)/);
  });
});

describe("アルバム保存の完全一致（B5）", () => {
  it("albumExact を送り、部分一致の別アルバムを除外する", async () => {
    setTestConnection({ token: "tok" });
    const fetchMock = mockFetch({
      body: [
        makeTrack({ trackId: 11, id: 11, album: "Dawn" }),
        makeTrack({ trackId: 12, id: 12, album: "Dawn (Remixes)" }),
      ],
    });

    await useDownloads.getState().downloadAlbum("Dawn");

    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("album=Dawn");
    expect(url).toContain("albumExact=true");
    expect(useDownloads.getState().isDownloaded(11)).toBe(true);
    expect(useDownloads.getState().isDownloaded(12)).toBe(false);
  });

  it("一覧の取得に失敗したらアルバム単位の失敗を残す", async () => {
    setTestConnection({ token: "tok" });
    mockFetch({ body: "x", status: 500 });
    await useDownloads.getState().downloadAlbum("Dawn");
    const f = useDownloads.getState().lastFailure;
    expect(f?.trackId).toBeNull();
    expect(f?.label).toBe("Dawn");
    expect(f?.message).toMatch(/^アルバムの取得に失敗しました/);
  });
});
