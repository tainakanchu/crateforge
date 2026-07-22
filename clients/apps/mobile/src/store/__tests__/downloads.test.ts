// useDownloads ストアの単体テスト。
// expo-file-system はグローバルモック（jest.setup.ts）を使う：
//   File.downloadFileAsync → exists=true, size=1024, uri="file:///mock/downloaded" を返す。
// 接続中の client（setTestConnection）と fetch モック（listTracks）で album DL も検証する。

import { File } from "expo-file-system";
import { createElement } from "react";
import { render, screen } from "@testing-library/react-native";

import { type Track, useDownloads, useSettings } from "@crateforge/core";
import DownloadsScreen from "@/app/downloads";
import {
  mockFetch,
  resetTestState,
  setTestConnection,
} from "@/test-utils";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const downloadFileAsync = File.downloadFileAsync as jest.Mock;
const deleteFile = jest.spyOn(File.prototype, "delete");

// 音源（= アートワーク以外）のダウンロード呼び出し回数。
// downloadTrack は音源に加えてアルバムアート（/artwork?...&format=webp）も取得するため、
// 「曲のダウンロード」を数えるときはアートワークの呼び出しを除外する。
function audioDownloadCount(): number {
  return downloadFileAsync.mock.calls.filter(
    (c) => !String((c as unknown[])[0]).includes("/artwork"),
  ).length;
}

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
  useDownloads.setState({ entries: {}, downloading: {}, playlists: {} });
  useSettings.setState({ downloadQuality: "aac192" });
});

describe("useDownloads", () => {
  it("downloadTrack がエントリを記録し isDownloaded/getLocalUri が反映される", async () => {
    setTestConnection({ baseUrl: "http://host:8787", token: "tok" });
    const track = makeTrack({ trackId: 100 });

    expect(useDownloads.getState().isDownloaded(100)).toBe(false);
    expect(useDownloads.getState().getLocalUri(100)).toBeNull();

    await useDownloads.getState().downloadTrack(track);

    // 音源は 1 回ダウンロードされる（アートワークは別途取得される）。
    expect(audioDownloadCount()).toBe(1);
    // アルバムアートの webp サムネもリクエストされる。
    expect(
      downloadFileAsync.mock.calls.some((c) =>
        String((c as unknown[])[0]).includes("format=webp"),
      ),
    ).toBe(true);
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
    expect(audioDownloadCount()).toBe(1);
    await useDownloads.getState().downloadTrack(track);
    // 2 回目は isDownloaded で早期 return するので音源 DL は増えない。
    expect(audioDownloadCount()).toBe(1);
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

    // 2 曲ともダウンロードされ記録される（音源 2 回。アートは別途）。
    expect(audioDownloadCount()).toBe(2);
    expect(useDownloads.getState().isDownloaded(11)).toBe(true);
    expect(useDownloads.getState().isDownloaded(12)).toBe(true);
    expect(useDownloads.getState().count()).toBe(2);
  });

  it("downloadPlaylist がプレイリストを記録しつつ曲を一括ダウンロードする", async () => {
    setTestConnection({ token: "tok" });
    const tracks = [
      makeTrack({ trackId: 21, id: 21 }),
      makeTrack({ trackId: 22, id: 22 }),
    ];

    await useDownloads.getState().downloadPlaylist(7, "My Playlist", tracks);

    // コレクションが正しく記録される（名前・順序保持の trackIds）。
    const dp = useDownloads.getState().playlists[7];
    expect(dp).toBeTruthy();
    expect(dp.playlistId).toBe(7);
    expect(dp.name).toBe("My Playlist");
    expect(dp.trackIds).toEqual([21, 22]);
    expect(dp.pinned).toBe(false);
    expect(useDownloads.getState().getDownloadedPlaylist(7)).toEqual(dp);

    // 曲も実際にダウンロード・記録される（音源 2 回。アートは別途）。
    expect(audioDownloadCount()).toBe(2);
    expect(useDownloads.getState().isDownloaded(21)).toBe(true);
    expect(useDownloads.getState().isDownloaded(22)).toBe(true);
  });

  it("removeDownloadedPlaylist がコレクション記録を消す（曲は残す）", async () => {
    setTestConnection({ token: "tok" });
    const tracks = [makeTrack({ trackId: 31, id: 31 })];
    await useDownloads.getState().downloadPlaylist(9, "PL", tracks);
    expect(useDownloads.getState().playlists[9]).toBeTruthy();

    await useDownloads.getState().removeDownloadedPlaylist(9);

    expect(useDownloads.getState().playlists[9]).toBeUndefined();
    expect(useDownloads.getState().getDownloadedPlaylist(9)).toBeNull();
    // 曲ファイル/エントリは消さない。
    expect(useDownloads.getState().isDownloaded(31)).toBe(true);
  });

  it("pin の再接続同期が追加曲を保存し、孤立した削除曲だけを消す", async () => {
    setTestConnection({ token: "tok" });
    const t1 = makeTrack({ trackId: 41, id: 41 });
    const t2 = makeTrack({ trackId: 42, id: 42 });
    const shared = makeTrack({ trackId: 43, id: 43 });
    const t4 = makeTrack({ trackId: 44, id: 44 });
    const added = makeTrack({ trackId: 45, id: 45 });
    await useDownloads.getState().downloadPlaylist(1, "A", [t1, t2, shared], true);
    await useDownloads.getState().downloadPlaylist(2, "B", [shared, t4], true);
    jest.clearAllMocks();

    await useDownloads.getState().syncPinnedPlaylists(async (playlistId) =>
      playlistId === 1 ? [t2, shared, added] : [shared, t4],
    );

    expect(useDownloads.getState().playlists[1].trackIds).toEqual([42, 43, 45]);
    expect(useDownloads.getState().isDownloaded(45)).toBe(true);
    expect(useDownloads.getState().isDownloaded(41)).toBe(false);
    expect(useDownloads.getState().isDownloaded(43)).toBe(true);
    expect(audioDownloadCount()).toBe(1);
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it("syncPinnedPlaylists の同時呼び出しは 1 回分の実行に合流する（再入防止）", async () => {
    setTestConnection({ token: "tok" });
    const t1 = makeTrack({ trackId: 41, id: 41 });
    const t2 = makeTrack({ trackId: 42, id: 42 });
    const shared = makeTrack({ trackId: 43, id: 43 });
    const t4 = makeTrack({ trackId: 44, id: 44 });
    const added = makeTrack({ trackId: 45, id: 45 });
    await useDownloads.getState().downloadPlaylist(1, "A", [t1, t2, shared], true);
    await useDownloads.getState().downloadPlaylist(2, "B", [shared, t4], true);
    jest.clearAllMocks();

    const fetchMembers = jest.fn(async (playlistId: number) =>
      playlistId === 1 ? [t2, shared, added] : [shared, t4],
    );

    // 再接続の連続発火（接続フラップ）を模して同時に 2 回呼ぶ。coalesce されるなら
    // 実行は 1 本化され、fetchMembers は pinned 数（2 件）ぶんしか呼ばれない
    // （2 回分の実行が走れば 4 回になるはず）。
    await Promise.all([
      useDownloads.getState().syncPinnedPlaylists(fetchMembers),
      useDownloads.getState().syncPinnedPlaylists(fetchMembers),
    ]);

    expect(fetchMembers).toHaveBeenCalledTimes(2);

    // 終状態も 1 回分の実行として正しいこと（membership 同期・孤立曲の削除は 1 回だけ）。
    expect(useDownloads.getState().playlists[1].trackIds).toEqual([42, 43, 45]);
    expect(useDownloads.getState().isDownloaded(45)).toBe(true);
    expect(useDownloads.getState().isDownloaded(41)).toBe(false);
    expect(useDownloads.getState().isDownloaded(43)).toBe(true);
    expect(audioDownloadCount()).toBe(1);
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it("pin 解除は専有曲を削除し、別の pin と共有する曲を残す", async () => {
    setTestConnection({ token: "tok" });
    const onlyA = makeTrack({ trackId: 51, id: 51 });
    const shared = makeTrack({ trackId: 52, id: 52 });
    const onlyB = makeTrack({ trackId: 53, id: 53 });
    await useDownloads.getState().downloadPlaylist(1, "A", [onlyA, shared], true);
    await useDownloads.getState().downloadPlaylist(2, "B", [shared, onlyB], true);
    jest.clearAllMocks();

    await useDownloads.getState().removeDownloadedPlaylist(1);

    expect(useDownloads.getState().playlists[1]).toBeUndefined();
    expect(useDownloads.getState().isDownloaded(51)).toBe(false);
    expect(useDownloads.getState().isDownloaded(52)).toBe(true);
    expect(useDownloads.getState().isDownloaded(53)).toBe(true);
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it("pin は記憶済み品質を使い、プレイリスト単位の実容量を集計する", async () => {
    setTestConnection({ token: "tok" });
    useSettings.setState({ downloadQuality: "aac256" });
    const first = makeTrack({ trackId: 61, id: 61 });
    const second = makeTrack({ trackId: 62, id: 62 });

    await useDownloads.getState().downloadPlaylist(6, "Pinned", [first, second, first], true);

    expect(useDownloads.getState().playlists[6].pinned).toBe(true);
    expect(useDownloads.getState().entries[61].quality).toBe("aac256");
    expect(useDownloads.getState().entries[62].quality).toBe("aac256");
    // 同じ trackId がメンバーに複数回あっても物理ファイル容量は一度だけ数える。
    expect(useDownloads.getState().playlistBytes(6)).toBe(2048);
    expect(useDownloads.getState().totalBytes()).toBe(2048);
  });

  it("ダウンロード画面に総容量と pin ごとの容量を整形して表示する", async () => {
    setTestConnection({ token: "tok" });
    const first = makeTrack({ trackId: 71, id: 71 });
    const second = makeTrack({ trackId: 72, id: 72 });
    await useDownloads.getState().downloadPlaylist(7, "Sized Playlist", [first, second], true);

    await render(createElement(DownloadsScreen));

    expect(screen.getByText("2曲 ・ 2.0 KB")).toBeTruthy();
    expect(screen.getByText("Sized Playlist")).toBeTruthy();
    // プレイリスト行にも整形済み容量が出る。
    expect(screen.getByText("2.0 KB")).toBeTruthy();
  });
});
