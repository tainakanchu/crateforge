// ExpoAudioEngine の単体テスト。expo-audio を制御可能なモックに差し替えて、
// load/play/pause/seekTo の委譲と、playbackStatusUpdate → ハンドラ転送を検証する。

import type { AudioStatus } from "expo-audio";

import { type Track } from "@crateforge/core";
import { setTestConnection, resetTestState } from "@/test-utils";

// --- 制御可能な expo-audio モック ---
// playbackStatusUpdate のリスナーを捕捉し、テストから手動発火できるようにする。
// jest.mock のファクトリは out-of-scope 変数を参照できないため、
// `mock` 接頭辞の単一ホルダにまとめてアクセスする。
interface MockAudio {
  listener: ((st: AudioStatus) => void) | null;
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
  setAudioModeAsync: jest.Mock;
  requestNotificationPermissionsAsync: jest.Mock;
}

const mockAudio: MockAudio = {
  listener: null,
  player: {
    volume: 1,
    play: jest.fn(),
    pause: jest.fn(),
    replace: jest.fn(),
    seekTo: jest.fn(async () => undefined),
    setActiveForLockScreen: jest.fn(),
    addListener: jest.fn((event: string, cb: (st: AudioStatus) => void) => {
      if (event === "playbackStatusUpdate") mockAudio.listener = cb;
      return { remove: jest.fn() };
    }),
    remove: jest.fn(),
  },
  createAudioPlayer: jest.fn(() => mockAudio.player),
  setAudioModeAsync: jest.fn(async () => undefined),
  requestNotificationPermissionsAsync: jest.fn(async () => ({
    granted: true,
    status: "granted",
  })),
};

jest.mock("expo-audio", () => ({
  createAudioPlayer: (source: unknown, options: unknown) =>
    mockAudio.createAudioPlayer(source, options),
  setAudioModeAsync: (mode: unknown) => mockAudio.setAudioModeAsync(mode),
  requestNotificationPermissionsAsync: () =>
    mockAudio.requestNotificationPermissionsAsync(),
}));

// モック適用後に import する。
import { ExpoAudioEngine, createAudioEngine, initPlayback } from "@crateforge/core";

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: 1,
    trackId: 555,
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
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAudio.listener = null;
  resetTestState();
});

describe("ExpoAudioEngine", () => {
  it("constructor が単一プレイヤーを生成し playbackStatusUpdate を購読する", () => {
    new ExpoAudioEngine();
    expect(mockAudio.createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(mockAudio.createAudioPlayer).toHaveBeenCalledWith(null, {
      updateInterval: 500,
    });
    expect(mockAudio.player.addListener).toHaveBeenCalledWith(
      "playbackStatusUpdate",
      expect.any(Function),
    );
    expect(mockAudio.listener).toBeTruthy();
  });

  it("load() が stream source を replace し、ロック画面メタを設定する", () => {
    const client = setTestConnection({ baseUrl: "http://host:8787", token: "tok" });
    const engine = new ExpoAudioEngine();
    const track = makeTrack();
    engine.load(track);

    // CRITICAL: trackId で解決していること。オフライン未保存なら native ストリームを使う。
    expect(mockAudio.player.replace).toHaveBeenCalledWith(
      client.streamSource(555, { native: true }),
    );
    expect(mockAudio.player.setActiveForLockScreen).toHaveBeenCalledWith(true, {
      title: "Test Song",
      artist: "Test Artist",
      albumTitle: "Test Album",
      artworkUrl: client.artworkUrl(555),
    });
  });

  it("load() は未接続なら何もしない", () => {
    const engine = new ExpoAudioEngine();
    engine.load(makeTrack());
    expect(mockAudio.player.replace).not.toHaveBeenCalled();
    expect(mockAudio.player.setActiveForLockScreen).not.toHaveBeenCalled();
  });

  it("play/pause/seekTo/setVolume を player に委譲する", () => {
    const engine = new ExpoAudioEngine();
    engine.play();
    expect(mockAudio.player.play).toHaveBeenCalled();
    engine.pause();
    expect(mockAudio.player.pause).toHaveBeenCalled();
    engine.seekTo(12);
    expect(mockAudio.player.seekTo).toHaveBeenCalledWith(12);
    engine.setVolume(0.5);
    expect(mockAudio.player.volume).toBe(0.5);
  });

  it("release() が player を remove する", () => {
    const engine = new ExpoAudioEngine();
    engine.release();
    expect(mockAudio.player.remove).toHaveBeenCalled();
  });

  it("playbackStatusUpdate が setHandlers で渡したハンドラへ転送される", () => {
    const engine = new ExpoAudioEngine();
    const onProgress = jest.fn();
    const onFinished = jest.fn();
    const onPlayingChange = jest.fn();
    engine.setHandlers({ onProgress, onFinished, onPlayingChange });

    // 秒 → ミリ秒変換と、playing/didJustFinish の転送を検証。
    mockAudio.listener?.({
      currentTime: 3,
      duration: 200,
      playing: true,
      didJustFinish: false,
    } as AudioStatus);
    expect(onProgress).toHaveBeenCalledWith(3000, 200000);
    expect(onPlayingChange).toHaveBeenCalledWith(true);
    expect(onFinished).not.toHaveBeenCalled();

    mockAudio.listener?.({
      currentTime: 200,
      duration: 200,
      playing: false,
      didJustFinish: true,
    } as AudioStatus);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("createAudioEngine() は ExpoAudioEngine を返す", () => {
    expect(createAudioEngine()).toBeInstanceOf(ExpoAudioEngine);
  });

  it("initPlayback() は doNotMix で audio mode を設定する", async () => {
    await initPlayback();
    expect(mockAudio.setAudioModeAsync).toHaveBeenCalledWith({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: "doNotMix",
    });
    expect(mockAudio.requestNotificationPermissionsAsync).toHaveBeenCalled();
  });
});
