// Remote 画面のテスト。コントロールの描画と再生/一時停止コマンドの送出を検証。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

import {
  createQueryWrapper,
  setTestConnection,
  mockFetch,
  resetTestState,
} from "@/test-utils";
import { type PlaybackState, type RemoteQueue, type Track, ApiClient } from "@crateforge/core";
import RemoteScreen from "@/app/(tabs)/remote";

// SafeAreaProvider をテストツリーに張らずに insets を固定で返す。
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 42,
    persistentId: null,
    name: "Now Playing",
    artist: "An Artist",
    albumArtist: null,
    composer: null,
    album: "An Album",
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

const STATE_PLAYING: PlaybackState = {
  isPlaying: true,
  currentTrackId: 42,
  positionMs: 30000,
  durationMs: 180000,
};

const STATE_PAUSED: PlaybackState = {
  isPlaying: false,
  currentTrackId: 42,
  positionMs: 30000,
  durationMs: 180000,
};

const QUEUE: RemoteQueue = { trackIds: [42, 43], currentIndex: 0 };

const TRACKS: Track[] = [
  makeTrack({ trackId: 42, name: "Now Playing" }),
  makeTrack({ id: 2, trackId: 43, name: "Next Up", artist: "Other" }),
];

beforeEach(() => {
  resetTestState();
  jest.restoreAllMocks();
});

describe("RemoteScreen", () => {
  test("未接続なら案内を表示する", async () => {
    const wrapper = createQueryWrapper();
    await render(<RemoteScreen />, { wrapper });
    expect(screen.getByText("サーバーに接続してください")).toBeTruthy();
  });

  test("再生中の曲・キュー・トランスポートを描画する", async () => {
    setTestConnection();
    mockFetch({ body: STATE_PLAYING }, { body: QUEUE }, { body: TRACKS });
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    await waitFor(() => expect(screen.getByText("Next Up")).toBeTruthy());
    expect(screen.getAllByText("Now Playing").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("一時停止")).toBeTruthy();
    expect(screen.getByLabelText("前の曲")).toBeTruthy();
    expect(screen.getByLabelText("次の曲")).toBeTruthy();
    expect(screen.getByLabelText("停止")).toBeTruthy();
  });

  test("再生中に再生/一時停止を押すと remotePause を呼ぶ", async () => {
    setTestConnection();
    mockFetch({ body: STATE_PLAYING }, { body: QUEUE }, { body: TRACKS });
    const spy = jest.spyOn(ApiClient.prototype, "remotePause").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    const btn = await screen.findByLabelText("一時停止");
    fireEvent.press(btn);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test("停止中に再生/一時停止を押すと remoteResume を呼ぶ", async () => {
    setTestConnection();
    mockFetch({ body: STATE_PAUSED }, { body: QUEUE }, { body: TRACKS });
    const spy = jest.spyOn(ApiClient.prototype, "remoteResume").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    const btn = await screen.findByLabelText("再生");
    fireEvent.press(btn);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test("次の曲ボタンで remoteNext を呼ぶ", async () => {
    setTestConnection();
    mockFetch({ body: STATE_PLAYING }, { body: QUEUE }, { body: TRACKS });
    const spy = jest.spyOn(ApiClient.prototype, "remoteNext").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    fireEvent.press(await screen.findByLabelText("次の曲"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test("キューの行をタップすると remoteSetQueue を呼ぶ", async () => {
    setTestConnection();
    mockFetch({ body: STATE_PLAYING }, { body: QUEUE }, { body: TRACKS });
    const spy = jest.spyOn(ApiClient.prototype, "remoteSetQueue").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    fireEvent.press(await screen.findByText("Next Up"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith([42, 43], 1));
  });
});
