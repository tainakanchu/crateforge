// Remote フックのテスト。接続済み状態 + fetch モック + React Query ラッパで検証。

import { renderHook, waitFor } from "@testing-library/react-native";

import {
  createQueryWrapper,
  setTestConnection,
  mockFetch,
  resetTestState,
} from "@/test-utils";
import { type PlaybackState, type RemoteQueue } from "@crateforge/core";
import { useRemoteState, useRemoteQueue, useRemoteCommands } from "@/features/remote/hooks";

const STATE: PlaybackState = {
  isPlaying: true,
  currentTrackId: 42,
  positionMs: 12000,
  durationMs: 180000,
};

const QUEUE: RemoteQueue = {
  trackIds: [42, 43, 44],
  currentIndex: 0,
};

beforeEach(() => {
  resetTestState();
  jest.restoreAllMocks();
});

describe("useRemoteState", () => {
  test("接続済みなら PlaybackState を返す", async () => {
    setTestConnection();
    mockFetch({ body: STATE });
    const wrapper = createQueryWrapper();

    const { result } = await renderHook(() => useRemoteState(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(STATE);
  });

  test("未接続なら enabled=false で実行されない", async () => {
    const fn = mockFetch({ body: STATE });
    const wrapper = createQueryWrapper();

    const { result } = await renderHook(() => useRemoteState(), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("useRemoteQueue", () => {
  test("RemoteQueue を返す", async () => {
    setTestConnection();
    mockFetch({ body: QUEUE });
    const wrapper = createQueryWrapper();

    const { result } = await renderHook(() => useRemoteQueue(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(QUEUE);
  });
});

describe("useRemoteCommands", () => {
  test("pause は /api/remote/pause に POST する", async () => {
    setTestConnection({ baseUrl: "http://host:8787" });
    const fn = mockFetch({ body: {} }, { body: STATE }, { body: QUEUE });
    const wrapper = createQueryWrapper();

    const { result } = await renderHook(() => useRemoteCommands(), { wrapper });

    await result.current.pause();

    expect(fn).toHaveBeenCalled();
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host:8787/api/remote/pause");
    expect(init.method).toBe("POST");
  });

  test("seek は positionMs を body に載せて POST する", async () => {
    setTestConnection({ baseUrl: "http://host:8787" });
    const fn = mockFetch({ body: {} });
    const wrapper = createQueryWrapper();

    const { result } = await renderHook(() => useRemoteCommands(), { wrapper });

    await result.current.seek(5000);

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host:8787/api/remote/seek");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ positionMs: 5000 });
  });

  test("setQueue は trackIds/startIndex を body に載せる", async () => {
    setTestConnection({ baseUrl: "http://host:8787" });
    const fn = mockFetch({ body: {} });
    const wrapper = createQueryWrapper();

    const { result } = await renderHook(() => useRemoteCommands(), { wrapper });

    await result.current.setQueue([1, 2, 3], 2);

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host:8787/api/remote/set-queue");
    expect(JSON.parse(String(init.body))).toEqual({ trackIds: [1, 2, 3], startIndex: 2 });
  });

  test("未接続なら何も送らない", async () => {
    const fn = mockFetch({ body: {} });
    const wrapper = createQueryWrapper();

    const { result } = await renderHook(() => useRemoteCommands(), { wrapper });
    await result.current.pause();

    expect(fn).not.toHaveBeenCalled();
  });
});
