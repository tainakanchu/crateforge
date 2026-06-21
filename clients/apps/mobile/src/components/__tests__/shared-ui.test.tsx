// 共有 UI とテストユーティリティのスモークテスト。
// 各 slice が依存する土台が壊れていないことを最低限保証する。

import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import TrackRow from "@/components/TrackRow";
import Artwork from "@/components/Artwork";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import MiniPlayer from "@/components/MiniPlayer";
import { createAudioEngine, initPlayback, ExpoAudioEngine, type Track } from "@crateforge/core";
import { createQueryWrapper, setTestConnection, mockFetch, resetTestState } from "@/test-utils";

// SafeAreaProvider 用の固定メトリクス（MiniPlayer は useSafeAreaInsets を使う）。
const SAFE_AREA_METRICS = {
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  frame: { x: 0, y: 0, width: 320, height: 640 },
};

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

describe("shared UI", () => {
  test("TrackRow renders title and subtitle", async () => {
    await render(<TrackRow track={makeTrack()} />);
    expect(screen.getByText("Test Song")).toBeTruthy();
    expect(screen.getByText("Test Artist — Test Album")).toBeTruthy();
  });

  test("Artwork renders placeholder when disconnected", async () => {
    const r = await render(<Artwork track={makeTrack()} />);
    expect(r.toJSON()).toBeTruthy();
  });

  test("StateViews render", async () => {
    const loading = await render(<Loading />);
    expect(loading.toJSON()).toBeTruthy();
    const err = await render(<ErrorView message="boom" onRetry={() => {}} />);
    expect(err.getByText("boom")).toBeTruthy();
    expect(err.getByText("再試行")).toBeTruthy();
    const empty = await render(<EmptyView message="empty" />);
    expect(empty.getByText("empty")).toBeTruthy();
  });

  test("MiniPlayer renders null when no current track", async () => {
    resetTestState();
    const r = await render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <MiniPlayer />
      </SafeAreaProvider>,
    );
    expect(r.queryByLabelText("プレイヤーを開く")).toBeNull();
  });
});

describe("playback engine", () => {
  test("createAudioEngine returns an ExpoAudioEngine", () => {
    expect(createAudioEngine()).toBeInstanceOf(ExpoAudioEngine);
  });

  test("initPlayback resolves", async () => {
    await expect(initPlayback()).resolves.toBeUndefined();
  });
});

describe("test-utils", () => {
  test("createQueryWrapper provides a QueryClient", async () => {
    const Wrapper = createQueryWrapper();
    const r = await render(
      <Wrapper>
        <TrackRow track={makeTrack()} />
      </Wrapper>,
    );
    expect(r.getByText("Test Song")).toBeTruthy();
  });

  test("setTestConnection sets a connected client", () => {
    const client = setTestConnection({ baseUrl: "host:9999", token: "t" });
    expect(client.baseUrl).toBe("http://host:9999");
    expect(client.token).toBe("t");
  });

  test("mockFetch returns queued responses in order", async () => {
    const fn = mockFetch({ body: { a: 1 } }, { body: "err", status: 500 });
    const r1 = await fetch("x");
    expect(r1.ok).toBe(true);
    expect(await r1.json()).toEqual({ a: 1 });
    const r2 = await fetch("x");
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
