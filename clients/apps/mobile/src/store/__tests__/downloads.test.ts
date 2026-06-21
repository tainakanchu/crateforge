// useDownloads ストアの単体テスト。
// expo-file-system はグローバルモック（jest.setup.ts）を使う：
//   File.downloadFileAsync → exists=true, size=1024, uri="file:///mock/downloaded" を返す。
// 接続中の client（setTestConnection）と fetch モック（listTracks）で album DL も検証する。

import { File } from "expo-file-system";

import { type Track, useDownloads, useSettings } from "@crateforge/core";
import {
  mockFetch,
  resetTestState,
  setTestConnection,
} from "@/test-utils";

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
  jest.clearAllMocks();
  resetTestState();
  // ストアを既定へ。
  useDownloads.setState({ entries: {}, downloading: {} });
  useSettings.setState({ downloadQuality: "aac192" });
});

describe("useDownloads", () => {
  it("downloadTrack がエントリを記録し isDownloaded/getLocalUri が反映される", async () => {
    setTestConnection({ baseUrl: "http://host:8787", token: "tok" });
    const track = makeTrack({ trackId: 100 });

    expect(useDownloads.getState().isDownloaded(100)).toBe(false);
    expect(useDownloads.getState().getLocalUri(100)).toBeNull();

    await useDownloads.getState().downloadTrack(track);

    expect(downloadFileAsync).toHaveBeenCalledTimes(1);
    const entry = useDownloads.getState().entries[100];
    expect(entry).toBeTruthy();
    expect(entry.trackId).toBe(100);
    expect(entry.localUri).toBe("file:///mock/downloaded");
    expect(entry.bytes).toBe(1024);
    expect(entry.quality).toBe("aac192");
    expect(useDownloads.getState().isDownloaded(100)).toBe(true);
    expect(useDownloads.getState().getLocalUri(100)).toBe("file:///mock/downloaded");
    // 進行中フラグは解除されていること。
    expect(useDownloads.getState().downloading[100]).toBeUndefined();
  });

  it("downloadTrack は接続が無いと何もしない", async () => {
    await useDownloads.getState().downloadTrack(makeTrack());
    expect(downloadFileAsync).not.toHaveBeenCalled();
    expect(useDownloads.getState().count()).toBe(0);
  });

  it("downloadTrack は既にダウンロード済みなら再取得しない", async () => {
    setTestConnection({ token: "tok" });
    const track = makeTrack({ trackId: 100 });
    await useDownloads.getState().downloadTrack(track);
    expect(downloadFileAsync).toHaveBeenCalledTimes(1);
    await useDownloads.getState().downloadTrack(track);
    expect(downloadFileAsync).toHaveBeenCalledTimes(1);
  });

  it("removeDownload がエントリを消す", async () => {
    setTestConnection({ token: "tok" });
    const track = makeTrack({ trackId: 100 });
    await useDownloads.getState().downloadTrack(track);
    expect(useDownloads.getState().isDownloaded(100)).toBe(true);

    await useDownloads.getState().removeDownload(100);
    expect(useDownloads.getState().isDownloaded(100)).toBe(false);
    expect(useDownloads.getState().getLocalUri(100)).toBeNull();
    expect(useDownloads.getState().count()).toBe(0);
  });

  it("clearAll が全エントリを消す", async () => {
    setTestConnection({ token: "tok" });
    await useDownloads.getState().downloadTrack(makeTrack({ trackId: 1, id: 1 }));
    await useDownloads.getState().downloadTrack(makeTrack({ trackId: 2, id: 2 }));
    expect(useDownloads.getState().count()).toBe(2);

    await useDownloads.getState().clearAll();
    expect(useDownloads.getState().count()).toBe(0);
    expect(useDownloads.getState().entries).toEqual({});
  });

  it("totalBytes/count が集計する", async () => {
    setTestConnection({ token: "tok" });
    await useDownloads.getState().downloadTrack(makeTrack({ trackId: 1, id: 1 }));
    await useDownloads.getState().downloadTrack(makeTrack({ trackId: 2, id: 2 }));
    expect(useDownloads.getState().count()).toBe(2);
    // モックの size=1024 が 2 件。
    expect(useDownloads.getState().totalBytes()).toBe(2048);
  });

  it("downloadAlbum が album でライブラリを引いて一括ダウンロードする", async () => {
    setTestConnection({ token: "tok" });
    const tracks = [
      makeTrack({ trackId: 11, id: 11, album: "My Album" }),
      makeTrack({ trackId: 12, id: 12, album: "My Album" }),
    ];
    const fetchMock = mockFetch({ body: tracks });

    await useDownloads.getState().downloadAlbum("My Album");

    // listTracks({ album }) が ?album=My%20Album で呼ばれる。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain("/api/tracks");
    expect(url).toContain("album=My%20Album");

    // 2 曲ともダウンロードされ記録される。
    expect(downloadFileAsync).toHaveBeenCalledTimes(2);
    expect(useDownloads.getState().isDownloaded(11)).toBe(true);
    expect(useDownloads.getState().isDownloaded(12)).toBe(true);
    expect(useDownloads.getState().count()).toBe(2);
  });
});
