// MiniPlayer の表示とトグル動作を検証する。

import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";

import { type Track, usePlayer } from "@crateforge/core";
import { resetTestState } from "@/test-utils";
import MiniPlayer from "@/components/MiniPlayer";

// SafeAreaProvider をテストツリーに張らずに insets を固定で返す。
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 100,
    persistentId: null,
    name: "Mini Song",
    artist: "Mini Artist",
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
    ...over,
  };
}

beforeEach(() => {
  resetTestState();
});

describe("MiniPlayer", () => {
  it("現在曲が無ければ何も描画しない", async () => {
    await render(<MiniPlayer />);
    expect(screen.queryByText("Mini Song")).toBeNull();
  });

  it("キューがあるとタイトル/アーティストを表示する", async () => {
    usePlayer.getState().setQueue([makeTrack()]);
    await render(<MiniPlayer />);
    expect(screen.getByText("Mini Song")).toBeTruthy();
    expect(screen.getByText("Mini Artist")).toBeTruthy();
  });

  it("再生/一時停止ボタンで isPlaying がトグルする", async () => {
    usePlayer.getState().setQueue([makeTrack()]);
    // setQueue で再生開始 → isPlaying=true。
    expect(usePlayer.getState().isPlaying).toBe(true);

    await render(<MiniPlayer />);
    // 再生中なので「一時停止」ボタンが出る。
    fireEvent.press(screen.getByLabelText("一時停止"));
    expect(usePlayer.getState().isPlaying).toBe(false);

    // 停止後は「再生」ボタンに切り替わる（再レンダリングを待つ）。
    const playBtn = await waitFor(() => screen.getByLabelText("再生"));
    fireEvent.press(playBtn);
    expect(usePlayer.getState().isPlaying).toBe(true);
  });
});
