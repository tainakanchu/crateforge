// TrackRow の meta line（3 行目）表示テスト。
// rowMetaFields 設定に応じて BPM などが表示される / されないことを確認する。

import { render, screen } from "@testing-library/react-native";

import TrackRow from "@/components/TrackRow";
import { useSettings, type Track } from "@crateforge/core";

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
  useSettings.setState({ rowMetaFields: ["bpm"], trackSort: { field: "name", order: "asc" } });
});

describe("TrackRow meta line", () => {
  it("rowMetaFields=['bpm'] で track.bpm=128 なら '128 BPM' が表示される", async () => {
    await render(<TrackRow track={makeTrack({ bpm: 128 })} />);
    expect(screen.getByText("128 BPM")).toBeTruthy();
  });

  it("rowMetaFields=[] なら meta line が表示されない", async () => {
    useSettings.setState({ rowMetaFields: [] });
    await render(<TrackRow track={makeTrack({ bpm: 128 })} />);
    expect(screen.queryByText("128 BPM")).toBeNull();
  });

  it("bpm が null なら meta line が表示されない", async () => {
    await render(<TrackRow track={makeTrack({ bpm: null })} />);
    expect(screen.queryByText(/BPM/)).toBeNull();
  });
});
