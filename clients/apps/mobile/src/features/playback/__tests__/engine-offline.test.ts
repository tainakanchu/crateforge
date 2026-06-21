// ExpoAudioEngine のオフライン分岐テスト。
// useDownloads にローカル uri があれば player.replace({ uri: <local> }) を、
// 無ければ client.streamSource(...) を使うことを検証する。
// expo-audio を制御可能モックに差し替えて replace の引数を捕捉する。

import { type Track, type DownloadEntry, useDownloads } from "@crateforge/core";
import { setTestConnection, resetTestState } from "@/test-utils";

interface MockAudio {
  player: {
    volume: number;
    play: jest.Mock;
    pause: jest.Mock;
    replace: jest.Mock;
    seekTo: jest.Mock;
    setActiveForLockScreen: jest.Mock;
    addListener: jest.Mock;
    remove: jest.Mock;
  };
  createAudioPlayer: jest.Mock;
}

const mockAudio: MockAudio = {
  player: {
    volume: 1,
    play: jest.fn(),
    pause: jest.fn(),
    replace: jest.fn(),
    seekTo: jest.fn(async () => undefined),
    setActiveForLockScreen: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    remove: jest.fn(),
  },
  createAudioPlayer: jest.fn(() => mockAudio.player),
};

jest.mock("expo-audio", () => ({
  createAudioPlayer: (source: unknown, options: unknown) =>
    mockAudio.createAudioPlayer(source, options),
  setAudioModeAsync: jest.fn(async () => undefined),
  requestNotificationPermissionsAsync: jest.fn(async () => ({
    granted: true,
    status: "granted",
  })),
}));

// モック適用後に import する。
import { ExpoAudioEngine } from "@crateforge/core";

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 777,
    persistentId: null,
    name: "Offline Song",
    artist: "Artist",
    albumArtist: null,
    composer: null,
    album: "Album",
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

function makeEntry(trackId: number, localUri: string): DownloadEntry {
  return {
    trackId,
    track: makeTrack({ trackId }),
    localUri,
    quality: "aac192",
    bytes: 1024,
    createdAt: Date.now(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTestState();
  useDownloads.setState({ entries: {}, downloading: {} });
});

describe("ExpoAudioEngine offline load", () => {
  it("ローカル保存済みなら player.replace({ uri: <local> }) を使う", () => {
    setTestConnection({ baseUrl: "http://host:8787", token: "tok" });
    const track = makeTrack({ trackId: 777 });
    useDownloads.setState({
      entries: { 777: makeEntry(777, "file:///mock/777.m4a") },
    });

    const engine = new ExpoAudioEngine();
    engine.load(track);

    expect(mockAudio.player.replace).toHaveBeenCalledWith({
      uri: "file:///mock/777.m4a",
    });
  });

  it("未保存ならネイティブストリーム source を使う", () => {
    const client = setTestConnection({ baseUrl: "http://host:8787", token: "tok" });
    const track = makeTrack({ trackId: 777 });

    const engine = new ExpoAudioEngine();
    engine.load(track);

    expect(mockAudio.player.replace).toHaveBeenCalledWith(
      client.streamSource(777, { native: true }),
    );
  });
});
