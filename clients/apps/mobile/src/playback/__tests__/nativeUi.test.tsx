// ネイティブ再生モードでの UI 回帰（design §8「MiniPlayer/player 画面が native モードで描画」）と、
// エラー表示・「AAC で再ダウンロード」導線（design D7）のテスト。

import { createElement } from "react";
import { Platform, ToastAndroid, Alert } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useSegments } from "expo-router";

import {
  installNativePlaybackBackend,
  useDownloads,
  usePlayer,
  type DownloadEntry,
  type NativePlaybackInstallation,
} from "@crateforge/core";
import MiniPlayer from "@/components/MiniPlayer";
import PlaybackErrorToast, { UNSUPPORTED_FORMAT_HINT } from "@/components/PlaybackErrorToast";
import DownloadsScreen from "@/app/downloads";
import PlayerScreen from "@/app/player";
import { createQueryWrapper, resetTestState, setTestConnection } from "@/test-utils";
import { FakeNativeBridge, flushPromises, makeTrack } from "../__fixtures__/fakeNativeBridge";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaView: ({ children }: { children?: unknown }) => children,
}));

let bridge: FakeNativeBridge;
let installation: NativePlaybackInstallation | null = null;

async function installNative(): Promise<void> {
  bridge.setNativeQueue([makeTrack(1, { name: "Native Song" }), makeTrack(2)], { index: 0 });
  bridge.state = { ...bridge.state, isPlaying: true };
  installation = installNativePlaybackBackend(bridge);
  await installation.ready;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTestState();
  bridge = new FakeNativeBridge();
  (useSegments as jest.Mock).mockReturnValue(["(tabs)"]);
});

afterEach(() => {
  installation?.uninstall();
  installation = null;
  jest.useRealTimers();
});

describe("MiniPlayer（ネイティブモード）", () => {
  it("ネイティブのキューを表示し、トグルはネイティブへ送ってから state で切り替わる", async () => {
    await installNative();
    await render(<MiniPlayer />);
    expect(screen.getByText("Native Song")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("一時停止"));
    await act(async () => {
      await flushPromises();
    });
    expect(bridge.pause).toHaveBeenCalledTimes(1);
    // 楽観更新しないので、ネイティブの state が来るまでは「一時停止」のまま。
    expect(screen.getByLabelText("一時停止")).toBeTruthy();

    await act(() => bridge.emit({ isPlaying: false }));
    const playBtn = await waitFor(() => screen.getByLabelText("再生"));
    await fireEvent.press(playBtn);
    await act(async () => {
      await flushPromises();
    });
    expect(bridge.play).toHaveBeenCalledTimes(1);
  });
});

describe("プレイヤー画面のスリープタイマー", () => {
  /** 実時間で少し待つ（画面側 setTimeout が発火し得る時間）。 */
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ネイティブモードでは画面側の setTimeout で止めない（ネイティブが実行主体）", async () => {
    await installNative();
    await act(() => bridge.emit({ sleepTimerMs: 20, sleepTimerEndsAtEpochMs: Date.now() + 20 }));
    await render(createElement(PlayerScreen), { wrapper: createQueryWrapper() });
    expect(screen.getByText("Native Song")).toBeTruthy();
    await act(async () => {
      await sleep(80);
    });
    expect(bridge.pause).not.toHaveBeenCalled();
    expect(bridge.setSleepTimer).not.toHaveBeenCalled();
    expect(bridge.setStopAtTrackEnd).not.toHaveBeenCalled();
  });

  it("JS エンジン経路では従来どおり画面側で停止する", async () => {
    setTestConnection();
    usePlayer.getState().setQueue([makeTrack(1, { name: "JS Song" })]);
    usePlayer.getState().setSleepTimer(20);
    await render(createElement(PlayerScreen), { wrapper: createQueryWrapper() });
    expect(screen.getByText("JS Song")).toBeTruthy();
    await waitFor(() => expect(usePlayer.getState().isPlaying).toBe(false));
    expect(usePlayer.getState().sleepTimerMs).toBeNull();
  });
});

describe("PlaybackErrorToast", () => {
  it("UNSUPPORTED_FORMAT は「AAC で再ダウンロード」への案内を添えて長めに出す", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const show = jest.spyOn(ToastAndroid, "show").mockImplementation(() => {});
    await installNative();
    await render(<PlaybackErrorToast />);
    await act(() =>
      bridge.emit({
        lastError: { code: "UNSUPPORTED_FORMAT", message: "この形式は再生できません", trackId: 1, atEpochMs: 10 },
      }),
    );
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(show).toHaveBeenCalledWith(
      `この形式は再生できません\n${UNSUPPORTED_FORMAT_HINT}`,
      ToastAndroid.LONG,
    );
    // 表示後に消費（ネイティブ側も clearError）。
    await waitFor(() => expect(usePlayer.getState().lastError).toBeNull());
    await act(async () => {
      await flushPromises();
    });
    expect(bridge.clearError).toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it("コマンド失敗は既存の通知経路で出る", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await installNative();
    bridge.skipNext.mockRejectedValueOnce(new Error("x"));
    await render(<PlaybackErrorToast />);
    await act(async () => {
      usePlayer.getState().next();
      await flushPromises(20);
    });
    expect(alert).toHaveBeenCalledWith("再生エラー", "操作に失敗しました");
    jest.restoreAllMocks();
    warn.mockRestore();
  });
});

describe("ダウンロード画面の「AAC で再ダウンロード」", () => {
  function entry(trackId: number, ext: string, quality: DownloadEntry["quality"]): DownloadEntry {
    return {
      trackId,
      track: makeTrack(trackId, { name: `Track ${trackId}` }),
      localUri: `file:///mock/document/downloads/${trackId}.${ext}`,
      quality,
      bytes: 1024,
      createdAt: trackId,
    };
  }

  beforeEach(() => {
    useDownloads.setState({
      entries: {
        1: entry(1, "aiff", "original"),
        2: entry(2, "mp3", "original"),
        3: entry(3, "aac", "aac192"),
        4: entry(4, "caf", "original"),
      },
    });
  });

  it("Android の AIFF/CAF 原本だけに出し、押すと aac192 で取り直す", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    setTestConnection();
    const redownloadTrack = jest.fn(async () => true);
    useDownloads.setState({ redownloadTrack });
    await render(createElement(DownloadsScreen));

    const buttons = screen.getAllByLabelText("AAC で再ダウンロード");
    expect(buttons).toHaveLength(2);
    expect(screen.getByText("AIFF はこの端末で再生できません")).toBeTruthy();
    expect(screen.getByText("CAF はこの端末で再生できません")).toBeTruthy();
    await fireEvent.press(buttons[0]);
    // 一覧は新しい順（createdAt desc）なので先頭は CAF（trackId 4）。
    expect(redownloadTrack).toHaveBeenCalledWith(4, "aac192");
    jest.restoreAllMocks();
  });

  it("未接続では押せない（理由を表示）", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const redownloadTrack = jest.fn(async () => true);
    useDownloads.setState({ redownloadTrack });
    await render(createElement(DownloadsScreen));
    const [button] = screen.getAllByLabelText("AAC で再ダウンロード");
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(button);
    expect(redownloadTrack).not.toHaveBeenCalled();
    expect(screen.getByText("AIFF はこの端末で再生できません（接続中に再ダウンロードできます）")).toBeTruthy();
    jest.restoreAllMocks();
  });

  it("iOS では出さない（AIFF/CAF を再生できる）", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    setTestConnection();
    await render(createElement(DownloadsScreen));
    expect(screen.queryByLabelText("AAC で再ダウンロード")).toBeNull();
    jest.restoreAllMocks();
  });
});
