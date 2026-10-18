// Android ネイティブ再生の配線テスト（design §5.3）。
// - bridge アダプタ（Track ⇄ NativeTrackJson、scope = serverId）
// - 接続情報の共有（setConnection / clearConnection、トークンをログに出さない）
// - ダウンロード変更 → notifyDownloadsChanged（debounce）
// - ブラウズ設定（artistGrouping）→ setBrowsePreferences

import { AppState, type AppStateStatus } from "react-native";
import * as AndroidAuto from "expo-crateforge-android-auto";

import {
  useConnection,
  useDownloads,
  useSettings,
  type DownloadEntry,
} from "@crateforge/core";
import { resetTestState } from "@/test-utils";
import {
  DOWNLOADS_NOTIFY_DEBOUNCE_MS,
  createAndroidAutoBridge,
  installAndroidNativePlayback,
  type AndroidNativePlayback,
} from "@/playback/androidNativePlayback";
import { flushPromises, makeTrack } from "../__fixtures__/fakeNativeBridge";

const mockAuto = AndroidAuto as jest.Mocked<typeof AndroidAuto>;
const SECRET = "super-secret-token-value";

let wiring: AndroidNativePlayback | null = null;

function entry(trackId: number): DownloadEntry {
  return {
    trackId,
    track: makeTrack(trackId),
    localUri: `file:///mock/document/downloads/${trackId}.aac`,
    quality: "aac192",
    bytes: 10,
    createdAt: trackId,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTestState();
  useConnection.setState({ hydrated: false, serverId: null });
  useSettings.setState({ artistGrouping: "artist" });
});

afterEach(() => {
  wiring?.dispose();
  wiring = null;
  jest.useRealTimers();
});

describe("createAndroidAutoBridge", () => {
  it("キュー系コマンドに接続中の serverId を scope として付ける", async () => {
    const bridge = createAndroidAutoBridge();
    const tracks = [makeTrack(1), makeTrack(2)];
    useConnection.setState({ serverId: "0123456789ABCDEF" });
    await bridge.setQueue(tracks, 1);
    await bridge.enqueue([tracks[0]], "next");
    expect(mockAuto.setQueue).toHaveBeenCalledWith(tracks, 1, "0123456789ABCDEF");
    expect(mockAuto.enqueue).toHaveBeenCalledWith([tracks[0]], "next", "0123456789ABCDEF");

    // serverId 不明（旧サーバー/未確認）は null（ネイティブが既知 scope で解決する）。
    useConnection.setState({ serverId: null });
    await bridge.setQueue(tracks, 0);
    expect(mockAuto.setQueue).toHaveBeenLastCalledWith(tracks, 0, null);
  });

  it("その他のコマンドはそのまま委譲する", async () => {
    const bridge = createAndroidAutoBridge();
    await bridge.playAt(3);
    await bridge.seekTo(1500);
    await bridge.setRepeat("all");
    await bridge.moveUpNext(2, 4);
    await bridge.setSleepTimer(null);
    await bridge.migrateLegacySettings({ shuffle: true, repeat: null });
    expect(mockAuto.playAt).toHaveBeenCalledWith(3);
    expect(mockAuto.seekTo).toHaveBeenCalledWith(1500);
    expect(mockAuto.setRepeat).toHaveBeenCalledWith("all");
    expect(mockAuto.moveUpNext).toHaveBeenCalledWith(2, 4);
    expect(mockAuto.setSleepTimer).toHaveBeenCalledWith(null);
    expect(mockAuto.migrateLegacySettings).toHaveBeenCalledWith({ shuffle: true, repeat: null });
  });
});

describe("接続情報の共有", () => {
  it("hydrate 完了前は何もしない（保存済みの接続を初期値で消さない）", () => {
    wiring = installAndroidNativePlayback();
    useConnection.setState({ baseUrl: "http://h:1", token: SECRET, status: "connecting" });
    expect(mockAuto.setConnection).not.toHaveBeenCalled();
    expect(mockAuto.clearConnection).not.toHaveBeenCalled();
  });

  it("baseUrl/token/serverId の変化で setConnection、切断で clearConnection", () => {
    wiring = installAndroidNativePlayback();
    useConnection.setState({
      baseUrl: "http://h:1",
      token: SECRET,
      serverId: null,
      status: "connecting",
      hydrated: true,
    });
    expect(mockAuto.setConnection).toHaveBeenLastCalledWith({
      baseUrl: "http://h:1",
      token: SECRET,
      serverId: null,
    });
    // probe 成功で serverId が判明。
    useConnection.setState({ serverId: "ABCDEF0123456789", status: "connected" });
    expect(mockAuto.setConnection).toHaveBeenLastCalledWith({
      baseUrl: "http://h:1",
      token: SECRET,
      serverId: "ABCDEF0123456789",
    });
    // 関係ない変化では送らない。
    useConnection.setState({ error: "x" });
    expect(mockAuto.setConnection).toHaveBeenCalledTimes(2);

    useConnection.setState({ baseUrl: null, token: null, serverId: null, status: "idle" });
    expect(mockAuto.clearConnection).toHaveBeenCalledTimes(1);
  });

  it("起動時に接続情報が無ければネイティブ側もクリアする", () => {
    useConnection.setState({ hydrated: true, baseUrl: null });
    wiring = installAndroidNativePlayback();
    expect(mockAuto.clearConnection).toHaveBeenCalledTimes(1);
    expect(mockAuto.setConnection).not.toHaveBeenCalled();
  });

  it("失敗してもトークンをログに出さない", async () => {
    const logs: unknown[][] = [];
    const capture = (...args: unknown[]) => void logs.push(args);
    const spies = [
      jest.spyOn(console, "warn").mockImplementation(capture),
      jest.spyOn(console, "log").mockImplementation(capture),
      jest.spyOn(console, "error").mockImplementation(capture),
    ];
    mockAuto.setConnection.mockRejectedValueOnce(
      Object.assign(new Error("keystore unavailable"), { code: "ERR_SERVICE" }),
    );
    wiring = installAndroidNativePlayback();
    useConnection.setState({ baseUrl: "http://h:1", token: SECRET, hydrated: true });
    await flushPromises();
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.map((args) => args.map(String)))).not.toContain(SECRET);
    for (const s of spies) s.mockRestore();
  });
});

describe("ダウンロード変更の通知", () => {
  it("index.json / playlists.json の書き出しをまとめて 1 回 notifyDownloadsChanged する", async () => {
    jest.useFakeTimers();
    useDownloads.setState({ entries: { 1: entry(1), 2: entry(2) } });
    wiring = installAndroidNativePlayback();

    await useDownloads.getState().removeDownload(1);
    await useDownloads.getState().removeDownload(2);
    useDownloads.getState().removeDownloadedPlaylist(5); // 未保存なので書き出さない
    expect(mockAuto.notifyDownloadsChanged).not.toHaveBeenCalled();

    jest.advanceTimersByTime(DOWNLOADS_NOTIFY_DEBOUNCE_MS);
    expect(mockAuto.notifyDownloadsChanged).toHaveBeenCalledTimes(1);
  });

  it("プレイリスト保存（playlists.json）でも通知する", async () => {
    jest.useFakeTimers();
    wiring = installAndroidNativePlayback();
    // 未接続なので曲の DL は走らず、コレクションの記録（persistPlaylists）だけ行われる。
    await useDownloads.getState().downloadPlaylist(9, "Mix", [makeTrack(1)]);
    jest.advanceTimersByTime(DOWNLOADS_NOTIFY_DEBOUNCE_MS);
    expect(mockAuto.notifyDownloadsChanged).toHaveBeenCalledTimes(1);
  });

  it("dispose 後は通知しない", async () => {
    jest.useFakeTimers();
    useDownloads.setState({ entries: { 1: entry(1) } });
    wiring = installAndroidNativePlayback();
    wiring.dispose();
    wiring = null;
    await useDownloads.getState().removeDownload(1);
    jest.advanceTimersByTime(DOWNLOADS_NOTIFY_DEBOUNCE_MS * 2);
    expect(mockAuto.notifyDownloadsChanged).not.toHaveBeenCalled();
  });
});

describe("ブラウズ設定の共有", () => {
  it("install 時と artistGrouping の変化時に setBrowsePreferences する", () => {
    wiring = installAndroidNativePlayback();
    expect(mockAuto.setBrowsePreferences).toHaveBeenLastCalledWith({ artistGrouping: "artist" });
    useSettings.setState({ artistGrouping: "albumArtist" });
    expect(mockAuto.setBrowsePreferences).toHaveBeenLastCalledWith({ artistGrouping: "albumArtist" });
    useSettings.setState({ downloadQuality: "aac128" });
    expect(mockAuto.setBrowsePreferences).toHaveBeenCalledTimes(2);
  });
});

describe("前面復帰時の再同期", () => {
  it("AppState が active になったら connect + getQueue で取り直す", async () => {
    let onChange: ((s: AppStateStatus) => void) | null = null;
    const remove = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, l) => {
      onChange = l as (s: AppStateStatus) => void;
      return { remove };
    });
    wiring = installAndroidNativePlayback();
    await wiring.ready;
    expect(mockAuto.connect).toHaveBeenCalledTimes(1);
    expect(mockAuto.getQueue).toHaveBeenCalledTimes(1);

    onChange!("background");
    await flushPromises();
    expect(mockAuto.connect).toHaveBeenCalledTimes(1);

    onChange!("active");
    await flushPromises(20);
    expect(mockAuto.connect).toHaveBeenCalledTimes(2);
    expect(mockAuto.getQueue).toHaveBeenCalledTimes(2);

    wiring.dispose();
    wiring = null;
    expect(remove).toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
