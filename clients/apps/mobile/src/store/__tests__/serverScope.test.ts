// Android Auto 対応で追加した core ストアの振る舞い：
// - useConnection.serverId（/api/health から取得・検証、切断で null）
// - ダウンロード記録への serverId 付与
// - setDownloadsPersistListener（書き出し後の通知）
// - redownloadTrack（端末非対応の原本を AAC で取り直す。失敗時は既存を残す）

import * as SecureStore from "expo-secure-store";
import { File } from "expo-file-system";

import {
  serverIdOf,
  setDownloadsPersistListener,
  useConnection,
  useDownloads,
  useSettings,
  type DownloadEntry,
} from "@crateforge/core";
import { mockFetch, resetTestState, setTestConnection } from "@/test-utils";
import { makeTrack } from "@/playback/__fixtures__/fakeNativeBridge";

const getItem = SecureStore.getItemAsync as jest.Mock;
const downloadFileAsync = File.downloadFileAsync as jest.Mock;

const SERVER_ID = "0123456789ABCDEF";

beforeEach(() => {
  jest.clearAllMocks();
  resetTestState();
  getItem.mockResolvedValue(null);
  useConnection.setState({ serverId: null, hydrated: false });
  useSettings.setState({ downloadQuality: "aac192" });
  setDownloadsPersistListener(null);
});

afterEach(() => {
  setDownloadsPersistListener(null);
});

describe("serverIdOf", () => {
  it("形式が正しい serverId だけを受け入れる", () => {
    expect(serverIdOf({ serverId: SERVER_ID })).toBe(SERVER_ID);
    expect(serverIdOf({ serverId: "lib_01-a" })).toBe("lib_01-a");
    expect(serverIdOf({})).toBeNull();
    expect(serverIdOf(null)).toBeNull();
    expect(serverIdOf({ serverId: "" })).toBeNull();
    expect(serverIdOf({ serverId: "../etc" })).toBeNull();
    expect(serverIdOf({ serverId: "x".repeat(65) })).toBeNull();
  });
});

describe("useConnection.serverId", () => {
  it("connect 成功で health の serverId を保持する", async () => {
    mockFetch({ body: { name: "c", version: "1", trackCount: 1, serverId: SERVER_ID } });
    await useConnection.getState().connect("host:8787", "tok");
    expect(useConnection.getState().serverId).toBe(SERVER_ID);
  });

  it("旧サーバー（serverId 無し）は null", async () => {
    mockFetch({ body: { name: "c", version: "1", trackCount: 1 } });
    await useConnection.getState().connect("host:8787", "tok");
    expect(useConnection.getState().status).toBe("connected");
    expect(useConnection.getState().serverId).toBeNull();
  });

  it("別サーバーへの接続を試みたら確認できるまで null に戻す", async () => {
    useConnection.setState({ serverId: SERVER_ID });
    mockFetch({ body: { error: "x" }, status: 500 });
    await useConnection.getState().connect("other:1", "tok");
    expect(useConnection.getState().serverId).toBeNull();
  });

  it("hydrate の疎通確認で serverId を設定し、disconnect で消す", async () => {
    getItem.mockImplementation(async (k: string) => (k === "crateforge.baseUrl" ? "http://h:2" : "t"));
    mockFetch({ body: { name: "c", version: "1", trackCount: 1, serverId: SERVER_ID } });
    await useConnection.getState().hydrate();
    expect(useConnection.getState().serverId).toBe(SERVER_ID);
    await useConnection.getState().disconnect();
    expect(useConnection.getState().serverId).toBeNull();
  });
});

describe("ダウンロード記録の serverId", () => {
  it("接続中サーバーの serverId を新規エントリ/プレイリストに記録する", async () => {
    setTestConnection({ baseUrl: "http://host:8787", token: "tok" });
    useConnection.setState({ serverId: SERVER_ID });
    await useDownloads.getState().downloadPlaylist(7, "Mix", [makeTrack(1)]);
    expect(useDownloads.getState().entries[1].serverId).toBe(SERVER_ID);
    expect(useDownloads.getState().playlists[7].serverId).toBe(SERVER_ID);
  });

  it("serverId 不明ならキー自体を書かない（旧データと同じ形）", async () => {
    setTestConnection();
    await useDownloads.getState().downloadTrack(makeTrack(2));
    expect("serverId" in useDownloads.getState().entries[2]).toBe(false);
  });

  it("downloadTrack は音質を明示指定できる", async () => {
    setTestConnection({ baseUrl: "http://host:8787" });
    useSettings.setState({ downloadQuality: "original" });
    await useDownloads.getState().downloadTrack(makeTrack(3), "aac128");
    expect(useDownloads.getState().entries[3].quality).toBe("aac128");
    expect(String(downloadFileAsync.mock.calls[0][0])).toContain("br=128");
  });
});

describe("setDownloadsPersistListener", () => {
  it("index.json / playlists.json の書き出し後に呼ばれ、null で解除できる", async () => {
    const listener = jest.fn();
    setDownloadsPersistListener(listener);
    setTestConnection();
    await useDownloads.getState().downloadTrack(makeTrack(4));
    expect(listener).toHaveBeenCalledTimes(1);
    await useDownloads.getState().downloadPlaylist(8, "P", []);
    expect(listener).toHaveBeenCalledTimes(2);

    setDownloadsPersistListener(null);
    await useDownloads.getState().removeDownload(4);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("リスナーの例外で永続化を壊さない", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    setDownloadsPersistListener(() => {
      throw new Error("boom");
    });
    setTestConnection();
    await useDownloads.getState().downloadTrack(makeTrack(5));
    expect(useDownloads.getState().isDownloaded(5)).toBe(true);
    warn.mockRestore();
  });
});

describe("redownloadTrack", () => {
  const aiffEntry: DownloadEntry = {
    trackId: 100,
    track: makeTrack(100, { locationPath: "/music/song.aiff" }),
    localUri: "file:///mock/document/downloads/100.aiff",
    quality: "original",
    bytes: 50_000_000,
    createdAt: 1,
  };

  it("AAC で取り直し、成功後に旧ファイルを消してエントリを置き換える", async () => {
    setTestConnection({ baseUrl: "http://host:8787" });
    useDownloads.setState({ entries: { 100: aiffEntry } });
    const listener = jest.fn();
    setDownloadsPersistListener(listener);
    const del = jest.spyOn(File.prototype, "delete");

    const ok = await useDownloads.getState().redownloadTrack(100, "aac192");
    expect(ok).toBe(true);
    const e = useDownloads.getState().entries[100];
    expect(e.quality).toBe("aac192");
    expect(e.localUri).not.toBe(aiffEntry.localUri);
    expect(String(downloadFileAsync.mock.calls[0][0])).toContain("fmt=aac");
    expect(del).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalled();
    expect(useDownloads.getState().downloading[100]).toBeUndefined();
    del.mockRestore();
  });

  it("未接続なら何もせず false（既存の保存は残る）", async () => {
    useDownloads.setState({ entries: { 100: aiffEntry } });
    expect(await useDownloads.getState().redownloadTrack(100, "aac192")).toBe(false);
    expect(useDownloads.getState().entries[100]).toBe(aiffEntry);
  });

  it("取得に失敗したら既存の保存を残して false", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    setTestConnection();
    useDownloads.setState({ entries: { 100: aiffEntry } });
    downloadFileAsync.mockRejectedValueOnce(new Error("network"));
    const del = jest.spyOn(File.prototype, "delete");
    expect(await useDownloads.getState().redownloadTrack(100, "aac192")).toBe(false);
    expect(useDownloads.getState().entries[100]).toBe(aiffEntry);
    expect(del).not.toHaveBeenCalled();
    expect(useDownloads.getState().downloading[100]).toBeUndefined();
    del.mockRestore();
    warn.mockRestore();
  });

  it("未保存の曲は false", async () => {
    setTestConnection();
    expect(await useDownloads.getState().redownloadTrack(999, "aac192")).toBe(false);
  });
});
