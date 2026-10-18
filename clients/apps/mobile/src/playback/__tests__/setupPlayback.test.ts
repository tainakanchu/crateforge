// setupPlayback の分岐テスト（design §8「setupPlayback の分岐」）。
// - Android + モジュールあり → ネイティブ再生（expo-audio の Player を作らない）
// - Android + モジュールなし（Expo Go / 旧 dev client）→ 従来の ExpoAudioEngine
// - iOS → 常に ExpoAudioEngine（モジュールが仮に available でも使わない）

import { Platform } from "react-native";
import * as Audio from "expo-audio";
import * as AndroidAuto from "expo-crateforge-android-auto";

import { isNativePlaybackActive, usePlayer } from "@crateforge/core";
import { resetTestState, setTestConnection } from "@/test-utils";
import {
  getPlaybackMode,
  onDownloadsHydrated,
  resetPlaybackSetupForTests,
  setupPlayback,
} from "@/playback/setupPlayback";
import { flushPromises, makeTrack } from "../__fixtures__/fakeNativeBridge";

const mockAuto = AndroidAuto as jest.Mocked<typeof AndroidAuto>;
const mockAudio = Audio as jest.Mocked<typeof Audio>;

function setPlatform(os: typeof Platform.OS): void {
  jest.replaceProperty(Platform, "OS", os);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTestState();
  mockAuto.isAvailable.mockReturnValue(false);
});

afterEach(() => {
  resetPlaybackSetupForTests();
  jest.restoreAllMocks();
});

describe("setupPlayback", () => {
  it("Android + モジュールあり → ネイティブ再生。expo-audio のプレイヤー/音声初期化は呼ばない", async () => {
    setPlatform("android");
    mockAuto.isAvailable.mockReturnValue(true);

    expect(setupPlayback()).toBe("native");
    expect(getPlaybackMode()).toBe("native");
    expect(isNativePlaybackActive()).toBe(true);
    expect(mockAudio.createAudioPlayer).not.toHaveBeenCalled();
    expect(mockAudio.setAudioModeAsync).not.toHaveBeenCalled();
    expect(mockAuto.connect).toHaveBeenCalledTimes(1);
    expect(mockAuto.addStateListener).toHaveBeenCalledTimes(1);
    expect(mockAuto.addProgressListener).toHaveBeenCalledTimes(1);

    // ストアの操作はネイティブへ流れる。
    await flushPromises();
    usePlayer.getState().setQueue([makeTrack(1)], 0);
    await flushPromises();
    expect(mockAuto.setQueue).toHaveBeenCalledWith([expect.objectContaining({ trackId: 1 })], 0, null);
  });

  it("2 回呼んでも再 install しない（StrictMode の effect 二重実行対策）", () => {
    setPlatform("android");
    mockAuto.isAvailable.mockReturnValue(true);
    setupPlayback();
    expect(setupPlayback()).toBe("native");
    expect(mockAuto.connect).toHaveBeenCalledTimes(1);
    expect(mockAuto.addStateListener).toHaveBeenCalledTimes(1);
  });

  it("Android + モジュールなし → 従来の expo-audio 経路", () => {
    setPlatform("android");
    mockAuto.isAvailable.mockReturnValue(false);

    expect(setupPlayback()).toBe("expo-audio");
    expect(isNativePlaybackActive()).toBe(false);
    expect(mockAudio.createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(mockAudio.setAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(mockAuto.connect).not.toHaveBeenCalled();
  });

  it("iOS → モジュールが available でも createAudioEngine（ExpoAudioEngine）を使う", () => {
    setPlatform("ios");
    mockAuto.isAvailable.mockReturnValue(true);

    expect(setupPlayback()).toBe("expo-audio");
    expect(isNativePlaybackActive()).toBe(false);
    expect(mockAudio.createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(mockAudio.setAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(mockAuto.connect).not.toHaveBeenCalled();
    expect(mockAuto.setConnection).not.toHaveBeenCalled();
  });

  it("expo-audio 経路では JS の自動送り（_onFinished → next）が従来どおり動く", () => {
    setPlatform("ios");
    setTestConnection();
    setupPlayback();
    const player = mockAudio.createAudioPlayer.mock.results[0].value as { replace: jest.Mock };
    usePlayer.getState().setQueue([makeTrack(1), makeTrack(2)], 0);
    player.replace.mockClear();
    usePlayer.getState()._onFinished();
    expect(usePlayer.getState().index).toBe(1);
    expect(player.replace).toHaveBeenCalledTimes(1);
  });

  it("onDownloadsHydrated はネイティブモードのときだけカタログ取り込みを促す", async () => {
    setPlatform("ios");
    setupPlayback();
    onDownloadsHydrated();
    expect(mockAuto.notifyDownloadsChanged).not.toHaveBeenCalled();

    resetPlaybackSetupForTests();
    setPlatform("android");
    mockAuto.isAvailable.mockReturnValue(true);
    setupPlayback();
    onDownloadsHydrated();
    await flushPromises();
    expect(mockAuto.notifyDownloadsChanged).toHaveBeenCalledTimes(1);
  });

  it("ネイティブ側の初期化が例外なら expo-audio へ退避する", () => {
    setPlatform("android");
    mockAuto.isAvailable.mockReturnValue(true);
    mockAuto.addStateListener.mockImplementationOnce(() => {
      throw new Error("no service");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(setupPlayback()).toBe("expo-audio");
    expect(mockAudio.createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});
