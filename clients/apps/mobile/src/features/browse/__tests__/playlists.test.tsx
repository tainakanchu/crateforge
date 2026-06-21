// Playlists タブのコンポーネントテスト。
// フォルダ階層のルート項目のみを表示し、フォルダ配下の子は出さないこと、
// フォルダ行のタップで /folder/ へ、プレイリスト行で /playlist/ へ遷移することを確認する。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import { type Playlist } from "@crateforge/core";
import { setTestConnection, createQueryWrapper, resetTestState, mockFetch } from "@/test-utils";
import PlaylistsScreen from "@/app/(tabs)/playlists";
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

beforeEach(() => {
  resetTestState();
  (router.push as jest.Mock).mockClear();
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

  test("shows connect prompt when no client", async () => {
    const Wrapper = createQueryWrapper();
    await render(
      <Wrapper>
        <PlaylistsScreen />
      </Wrapper>,
    );
    expect(await screen.findByText("サーバーに接続してください")).toBeTruthy();
  });
});
