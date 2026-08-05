// Playlists タブのコンポーネントテスト。
// フォルダ階層のルート項目のみを表示し、フォルダ配下の子は出さないこと、
// フォルダ行のタップで /folder/ へ、プレイリスト行で /playlist/ へ遷移することを確認する。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import { type DownloadEntry, type Playlist, type Track, useDownloads, usePlayer } from "@crateforge/core";
import { setTestConnection, createQueryWrapper, resetTestState, mockFetch } from "@/test-utils";
import PlaylistsScreen from "@/app/(tabs)/playlists";
import PlaylistScreen from "@/app/playlist/[id]";
import { childrenOf, rootItems } from "@/features/browse/playlistTree";

// SafeAreaProvider を張らずに insets を固定で返す。
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 1,
    playlistId: 100,
    persistentId: null,
    parentPersistentId: null,
    name: "My List",
    isFolder: false,
    isSmart: false,
    isUserCreated: true,
    trackCount: 3,
    ...overrides,
  };
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 701,
    persistentId: null,
    name: "Offline Song",
    artist: "Offline Artist",
    albumArtist: null,
    composer: null,
    album: "Offline Album",
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
    locationPath: "/music/offline.m4a",
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

function makeEntry(track: Track): DownloadEntry {
  return {
    trackId: track.trackId,
    track,
    localUri: `file:///mock/${track.trackId}.m4a`,
    quality: "aac192",
    bytes: 1024,
    createdAt: 1,
  };
}

beforeEach(() => {
  resetTestState();
  (router.push as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

describe("playlistTree", () => {
  test("rootItems keeps top-level and orphan items, drops nested children", () => {
    const all = [
      makePlaylist({ playlistId: 1, persistentId: "F", name: "Folder", isFolder: true }),
      makePlaylist({ playlistId: 2, persistentId: "C", parentPersistentId: "F", name: "Child" }),
      makePlaylist({ playlistId: 3, persistentId: "R", name: "Root" }),
      makePlaylist({ playlistId: 4, persistentId: "O", parentPersistentId: "GONE", name: "Orphan" }),
    ];
    const roots = rootItems(all).map((p) => p.name);
    // フォルダ優先 → 名前順。Child は F 配下なので除外。Orphan は親不在なのでルート扱い。
    expect(roots).toEqual(["Folder", "Orphan", "Root"]);
  });

  test("childrenOf returns direct children sorted folders-first then name", () => {
    const all = [
      makePlaylist({ playlistId: 1, persistentId: "F", name: "Folder", isFolder: true }),
      makePlaylist({ playlistId: 2, persistentId: "P2", parentPersistentId: "F", name: "Beta" }),
      makePlaylist({
        playlistId: 3,
        persistentId: "SUB",
        parentPersistentId: "F",
        name: "Alpha",
        isFolder: true,
      }),
      makePlaylist({ playlistId: 4, persistentId: "P1", parentPersistentId: "F", name: "Apple" }),
    ];
    expect(childrenOf(all, "F").map((p) => p.name)).toEqual(["Alpha", "Apple", "Beta"]);
  });
});

describe("PlaylistsScreen", () => {
  test("shows folder + root playlist but NOT the nested child; folder tap navigates to /folder/", async () => {
    setTestConnection();
    const playlists = [
      makePlaylist({ playlistId: 1, persistentId: "F1", name: "House", isFolder: true }),
      makePlaylist({
        playlistId: 2,
        persistentId: "C1",
        parentPersistentId: "F1",
        name: "Deep House",
      }),
      makePlaylist({ playlistId: 3, persistentId: "R1", name: "Bangers" }),
    ];
    mockFetch({ body: playlists });

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <PlaylistsScreen />
      </Wrapper>,
    );

    // フォルダとルートのプレイリストは出る。
    const folderRow = await screen.findByText("House");
    expect(screen.getByText("Bangers")).toBeTruthy();
    // ネストした子は出ない。
    expect(screen.queryByText("Deep House")).toBeNull();

    // フォルダタップは /folder/<persistentId> へ。
    fireEvent.press(folderRow);
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/folder/F1");
    });
  });

  test("tapping a root playlist navigates to its detail", async () => {
    setTestConnection();
    const playlists = [makePlaylist({ playlistId: 100, persistentId: "R", name: "Chill" })];
    mockFetch({ body: playlists });

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <PlaylistsScreen />
      </Wrapper>,
    );

    fireEvent.press(await screen.findByText("Chill"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/playlist/100");
    });
  });

  test("keeps folders even when their trackCount is 0", async () => {
    setTestConnection();
    const playlists = [
      makePlaylist({
        playlistId: 1,
        persistentId: "F",
        name: "Empty Folder",
        isFolder: true,
        trackCount: 0,
      }),
    ];
    mockFetch({ body: playlists });

    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <PlaylistsScreen />
      </Wrapper>,
    );

    expect(await screen.findByText("Empty Folder")).toBeTruthy();
  });

  test("shows offline empty state when no client and no downloaded playlists", async () => {
    // client 未設定・DL済みプレイリスト0件 → オフライン空表示と接続導線を出す。
    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <PlaylistsScreen />
      </Wrapper>,
    );
    expect(await screen.findByText("オフライン保存されたプレイリストはありません")).toBeTruthy();
    // 接続導線のボタンテキストも表示される。
    expect(screen.getByText("サーバーに接続")).toBeTruthy();
  });

  test("persisted pin is browsable and playable without a client", async () => {
    const track = makeTrack();
    useDownloads.setState({
      entries: { [track.trackId]: makeEntry(track) },
      playlists: {
        7: {
          playlistId: 7,
          name: "Pinned Offline",
          trackIds: [track.trackId],
          createdAt: 1,
          pinned: true,
        },
      },
    });
    const Wrapper = createQueryWrapper();
    const list = await render(
      <Wrapper>
        <PlaylistsScreen />
      </Wrapper>,
    );

    fireEvent.press(await screen.findByText("Pinned Offline"));
    expect(router.push).toHaveBeenCalledWith("/playlist/7");
    list.unmount();

    (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "7" });
    await render(
      <Wrapper>
        <PlaylistScreen />
      </Wrapper>,
    );
    fireEvent.press(await screen.findByText("Offline Song"));

    expect(usePlayer.getState().current()?.trackId).toBe(track.trackId);
    expect(router.push).toHaveBeenCalledWith("/player");
  });
});
