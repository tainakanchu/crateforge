// Remote 画面のテスト。コントロールの描画と再生/一時停止コマンドの送出を検証。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

import {
  createQueryWrapper,
  setTestConnection,
  resetTestState,
} from "@/test-utils";
import {
  type PlaybackState,
  type RemoteQueue,
  type Track,
  ApiClient,
  ApiError,
  NetworkError,
} from "@crateforge/core";
import RemoteScreen from "@/app/(tabs)/remote";
import { useToast } from "@/components/Toast";

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

/**
 * URL で応答を振り分ける fetch モック。RemoteScreen は state を 1 秒間隔でポーリングするため、
 * 呼び出し順で応答を返す mockFetch だと遅い CI で再取得が別の応答を受け取りテストが揺れる。
 */
function mockRemote(state: unknown): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const body = url.includes("/api/remote/state")
      ? state
      : url.includes("/api/remote/queue")
        ? QUEUE
        : TRACKS;
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
    mockRemote(STATE_PLAYING);
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
    mockRemote(STATE_PLAYING);
    const spy = jest.spyOn(ApiClient.prototype, "remotePause").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    const btn = await screen.findByLabelText("一時停止");
    fireEvent.press(btn);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test("停止中に再生/一時停止を押すと remoteResume を呼ぶ", async () => {
    setTestConnection();
    mockRemote(STATE_PAUSED);
    const spy = jest.spyOn(ApiClient.prototype, "remoteResume").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    const btn = await screen.findByLabelText("再生");
    fireEvent.press(btn);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test("次の曲ボタンで remoteNext を呼ぶ", async () => {
    setTestConnection();
    mockRemote(STATE_PLAYING);
    const spy = jest.spyOn(ApiClient.prototype, "remoteNext").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    fireEvent.press(await screen.findByLabelText("次の曲"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test("キューの行をタップすると remotePlayAt でその位置から再生する", async () => {
    setTestConnection();
    mockRemote(STATE_PLAYING);
    const spy = jest.spyOn(ApiClient.prototype, "remotePlayAt").mockResolvedValue({ trackId: 43 });
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    fireEvent.press(await screen.findByText("Next Up"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(1));
  });

  test("play-at 未対応の古いホスト（404）では set-queue + play にフォールバックする", async () => {
    setTestConnection();
    mockRemote(STATE_PLAYING);
    jest
      .spyOn(ApiClient.prototype, "remotePlayAt")
      .mockRejectedValue(new ApiError(404, "HTTP 404"));
    const spy = jest.spyOn(ApiClient.prototype, "remoteSetQueue").mockResolvedValue({});
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    fireEvent.press(await screen.findByText("Next Up"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith([42, 43], 1, { play: true }));
  });

  test("操作が失敗したらトーストで通知する", async () => {
    setTestConnection();
    mockRemote(STATE_PLAYING);
    jest
      .spyOn(ApiClient.prototype, "remoteNext")
      .mockRejectedValue(new NetworkError("Network request failed"));
    const wrapper = createQueryWrapper();

    await render(<RemoteScreen />, { wrapper });

    fireEvent.press(await screen.findByLabelText("次の曲"));
    await waitFor(() =>
      expect(useToast.getState().message).toMatch(/^次の曲に失敗しました: デスクトップに接続できません/),
    );
    expect(useToast.getState().kind).toBe("error");
  });

  describe("音量・シャッフル・リピート・シーク", () => {
    const FULL: PlaybackState = { ...STATE_PLAYING, volume: 0.5, shuffle: false, repeat: "off" };

    test("ホストが報告する項目だけ描画する（旧ホストでは出さない）", async () => {
      setTestConnection();
      mockRemote(STATE_PLAYING);
      await render(<RemoteScreen />, { wrapper: createQueryWrapper() });
      await screen.findByLabelText("一時停止");
      expect(screen.queryByLabelText("音量")).toBeNull();
      expect(screen.queryByLabelText(/^シャッフル/)).toBeNull();
      expect(screen.queryByLabelText(/^リピート/)).toBeNull();
    });

    test("報告された項目ごとに表示する（volume だけ）", async () => {
      setTestConnection();
      mockRemote({ ...STATE_PLAYING, volume: 0.3 });
      await render(<RemoteScreen />, { wrapper: createQueryWrapper() });
      expect(await screen.findByLabelText("音量")).toBeTruthy();
      expect(screen.queryByLabelText(/^シャッフル/)).toBeNull();
    });

    test("シャッフルをタップすると setShuffle(true)", async () => {
      setTestConnection();
      mockRemote(FULL);
      const spy = jest.spyOn(ApiClient.prototype, "remoteShuffle").mockResolvedValue({});
      await render(<RemoteScreen />, { wrapper: createQueryWrapper() });
      fireEvent.press(await screen.findByLabelText("シャッフル（オフ）"));
      await waitFor(() => expect(spy).toHaveBeenCalledWith(true));
    });

    test("リピートは off → all → one → off と循環する", async () => {
      setTestConnection();
      mockRemote({ ...FULL, repeat: "one" });
      const spy = jest.spyOn(ApiClient.prototype, "remoteRepeat").mockResolvedValue({});
      await render(<RemoteScreen />, { wrapper: createQueryWrapper() });
      fireEvent.press(await screen.findByLabelText("リピート（1曲リピート）"));
      await waitFor(() => expect(spy).toHaveBeenCalledWith("off"));
    });

    test("音量バーのドラッグを離すと setVolume(比率)", async () => {
      setTestConnection();
      mockRemote(FULL);
      const spy = jest.spyOn(ApiClient.prototype, "remoteVolume").mockResolvedValue({});
      await render(<RemoteScreen />, { wrapper: createQueryWrapper() });
      const bar = await screen.findByLabelText("音量");
      await fireEvent(bar, "layout", { nativeEvent: { layout: { width: 200, height: 44 } } });
      await fireEvent(bar, "responderGrant", { nativeEvent: { locationX: 20, pageX: 120 } });
      await fireEvent(bar, "responderMove", { nativeEvent: { locationX: 0, pageX: 220 } });
      await fireEvent(bar, "responderRelease", { nativeEvent: { locationX: 0, pageX: 220 } });
      // 20 + (220-120) = 120 / 200 = 0.6
      await waitFor(() => expect(spy).toHaveBeenCalledWith(0.6));
    });

    test("シークバーのドラッグを離すと remoteSeek(ms)。ドラッグ中は呼ばない", async () => {
      setTestConnection();
      mockRemote(FULL);
      const spy = jest.spyOn(ApiClient.prototype, "remoteSeek").mockResolvedValue({});
      await render(<RemoteScreen />, { wrapper: createQueryWrapper() });
      const bar = await screen.findByLabelText("シークバー");
      await fireEvent(bar, "layout", { nativeEvent: { layout: { width: 200, height: 44 } } });
      await fireEvent(bar, "responderGrant", { nativeEvent: { locationX: 0, pageX: 50 } });
      await fireEvent(bar, "responderMove", { nativeEvent: { locationX: 0, pageX: 150 } });
      expect(spy).not.toHaveBeenCalled();
      await fireEvent(bar, "responderRelease", { nativeEvent: { locationX: 0, pageX: 150 } });
      // 100/200 * 180000
      await waitFor(() => expect(spy).toHaveBeenCalledWith(90000));
    });
  });
});
