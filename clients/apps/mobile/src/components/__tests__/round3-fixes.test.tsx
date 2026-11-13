// round-3 の修正の回帰テスト（N1–N8）。

import { Alert } from "react-native";
import { act, render, renderHook, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";

import {
  ApiClient,
  ApiError,
  type Track,
  describeApiError,
  extractErrorBodyMessage,
  serverErrorMessage,
  useConnection,
  usePlayer,
} from "@crateforge/core";
import PlaybackErrorToast, { PLAYBACK_ERROR_BURST_MS } from "@/components/PlaybackErrorToast";
import ConnectionNotice from "@/components/ConnectionNotice";
import { useToast } from "@/components/Toast";
import { useActionSheet } from "@/components/ActionSheet";
import RemoteScreen from "@/app/(tabs)/remote";
import ConnectScreen from "@/app/connect";
import PlaylistScreen from "@/app/playlist/[id]";
import { showTrackMenu } from "@/features/playback/trackMenu";
import { playOnDesktop } from "@/features/playback/desktopPlay";
import { LIGHT_LIST_FRESH_MS, useRefetchStaleOnFocus } from "@/hooks/use-refresh";
import { connectionRecovery, disconnectedBody } from "@/lib/connectionStatus";
import { positionalTrackKey } from "@/lib/listKeys";
import { createQueryWrapper, resetTestState, setTestConnection } from "@/test-utils";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  resetTestState();
  useConnection.setState({ errorKind: null, checking: false, lastOkAt: null, lastBaseUrl: null, lastToken: null });
  useToast.setState({ message: null, kind: "info" });
  useActionSheet.setState({ current: null });
  (router.push as jest.Mock).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("N1 再生エラーはアプリ内トーストで曲名つき・連続失敗はまとめる", () => {
  test("Alert を出さず、曲名つきトースト → 連続失敗は件数にまとめ → 停止で締める", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    await render(<PlaybackErrorToast />);

    await act(async () => {
      usePlayer.setState({ lastError: { message: "再生できませんでした（x）", at: 1000, title: "Song A" } });
    });
    expect(useToast.getState().message).toBe("「Song A」: 再生できませんでした（x）");
    expect(useToast.getState().kind).toBe("error");
    expect(usePlayer.getState().lastError).toBeNull();

    await act(async () => {
      usePlayer.setState({ lastError: { message: "再生できませんでした（y）", at: 2000, title: "Song B" } });
    });
    expect(useToast.getState().message).toBe("再生できない曲を 2 曲スキップしました（直近: 「Song B」）");

    await act(async () => {
      usePlayer.setState({
        lastError: { message: "再生できない曲が続いたため停止しました", at: 3000, title: "Song C", stopped: true },
      });
    });
    expect(useToast.getState().message).toBe("再生できない曲が続いたため停止しました（3 曲）");

    // 停止で締めたあと・時間が空いたあとは新しい 1 件目。
    await act(async () => {
      usePlayer.setState({
        lastError: { message: "再生できませんでした（z）", at: 3000 + PLAYBACK_ERROR_BURST_MS + 1, title: "Song D" },
      });
    });
    expect(useToast.getState().message).toBe("「Song D」: 再生できませんでした（z）");
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("N2 未接続表示の文言", () => {
  const base = { checking: false, lastOkAt: null, baseUrl: "http://h:1" } as const;

  test("トークン不一致のバナー理由は短く 1 行に収まる", async () => {
    const r = connectionRecovery({ ...base, status: "error", errorKind: "unauthorized" });
    expect(r.reason).toBe("トークンが一致しません");
    useConnection.setState({ baseUrl: "http://h:1", status: "error", errorKind: "unauthorized", client: null });
    await render(<ConnectionNotice />);
    expect(screen.getByText("トークンが一致しません")).toBeTruthy();
  });

  test("本文は状態に応じて出し分ける（オフライン中に「接続してください」と出さない）", () => {
    expect(disconnectedBody({ ...base, status: "error", errorKind: "network" }).message).toMatch(/再接続を待っています/);
    expect(disconnectedBody({ ...base, status: "error", errorKind: "unauthorized" }).message).toMatch(/トークンを入力し直す/);
    expect(disconnectedBody({ ...base, status: "error", errorKind: "notCrateforge" }).message).toBe("接続先を確認してください");
    expect(disconnectedBody({ ...base, baseUrl: null, status: "idle", errorKind: null }).message).toBe(
      "サーバーに接続してください",
    );
  });

  test("リモートタブ: オフライン時はバナーと矛盾しない本文", async () => {
    useConnection.setState({ baseUrl: "http://h:1", status: "error", errorKind: "network", client: null });
    await render(<RemoteScreen />, { wrapper: createQueryWrapper() });
    expect(screen.getByText(/デスクトップに届きません/)).toBeTruthy();
    expect(screen.getByText(/再接続を待っています/)).toBeTruthy();
    expect(screen.queryByText("サーバーに接続してください")).toBeNull();
  });
});

describe("N3 接続失敗でも入力した接続先を残す", () => {
  const setItem = SecureStore.setItemAsync as jest.Mock;

  test("connect 失敗で lastBaseUrl / lastToken に退避して永続化する（自動再接続キーには入れない）", async () => {
    setItem.mockClear();
    global.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    const ok = await useConnection.getState().connect("192.0.2.2:18833", "tok");
    expect(ok).toBe(false);
    const st = useConnection.getState();
    expect(st.lastBaseUrl).toBe("http://192.0.2.2:18833");
    expect(st.lastToken).toBe("tok");
    expect(setItem).toHaveBeenCalledWith("crateforge.lastBaseUrl", "http://192.0.2.2:18833");
    expect(setItem).toHaveBeenCalledWith("crateforge.lastToken", "tok");
    expect(setItem).not.toHaveBeenCalledWith("crateforge.baseUrl", expect.anything());
  });

  test("デスクトップ不達の失敗にだけ「自動で接続します」を添える", async () => {
    await render(<ConnectScreen />);
    await act(async () => {
      useConnection.setState({
        baseUrl: "http://h:1",
        status: "error",
        errorKind: "network",
        error: "デスクトップに接続できません",
      });
    });
    expect(screen.getByText(/デスクトップが起動すると自動で接続します/)).toBeTruthy();

    await act(async () => {
      useConnection.setState({ status: "error", errorKind: "notCrateforge", error: "Crateforge の API ではない URL です" });
    });
    expect(screen.queryByText(/自動で接続します/)).toBeNull();
  });
});

describe("N4 曲メニューに「アルバムを見る」", () => {
  test("album があれば出し、押すとアルバム詳細へ", () => {
    showTrackMenu(makeTrack({ album: "Dawn (Remixes)" }));
    const action = useActionSheet.getState().current?.actions.find((a) => a.label === "アルバムを見る");
    expect(action).toBeTruthy();
    action!.onPress?.();
    expect(router.push).toHaveBeenCalledWith("/album/Dawn%20(Remixes)");
  });

  test("album が空なら出さない", () => {
    showTrackMenu(makeTrack({ album: "  " }));
    expect(useActionSheet.getState().current?.actions.some((a) => a.label === "アルバムを見る")).toBe(false);
  });
});

describe("N5 タブ復帰時の再取得は現在タブのクエリだけ", () => {
  test("指定キーだけ、鮮度閾値（10 秒）を過ぎていれば取り直す。他タブの stale クエリは触らない", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const playlistsFn = jest.fn(async () => ["p"]);
    const albumsFn = jest.fn(async () => ["a"]);
    const now = Date.now();
    // プレイリスト: 20 秒前に取得（staleTime 内だが 10 秒の鮮度閾値は超過）。
    qc.setQueryData(["playlists"], ["old"], { updatedAt: now - 20_000 });
    // アルバム（他タブ）: 10 分前に取得＝stale。
    qc.setQueryData(["albums"], ["old"], { updatedAt: now - 600_000 });
    const subs = [
      new QueryObserver(qc, { queryKey: ["playlists"], queryFn: playlistsFn, refetchOnMount: false }).subscribe(() => {}),
      new QueryObserver(qc, { queryKey: ["albums"], queryFn: albumsFn, refetchOnMount: false }).subscribe(() => {}),
    ];
    const focus = useFocusEffect as jest.Mock;
    focus.mockClear();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    await renderHook(
      () => useRefetchStaleOnFocus([{ queryKey: ["playlists"], freshMs: LIGHT_LIST_FRESH_MS }]),
      { wrapper },
    );
    const onFocus = focus.mock.calls[focus.mock.calls.length - 1][0] as () => void;
    onFocus(); // 初回マウントは何もしない
    expect(playlistsFn).not.toHaveBeenCalled();
    await act(async () => {
      onFocus(); // タブに戻った
    });
    expect(playlistsFn).toHaveBeenCalledTimes(1);
    expect(albumsFn).not.toHaveBeenCalled();

    // 取り直した直後（閾値内）にもう一度戻っても取り直さない。
    await act(async () => {
      onFocus();
    });
    expect(playlistsFn).toHaveBeenCalledTimes(1);
    subs.forEach((u) => u());
    qc.clear();
  });
});

describe("N6 同じ曲を 2 回含むプレイリストで key が重複しない", () => {
  test("positionalTrackKey は位置で一意", () => {
    const t = makeTrack({ trackId: 5 });
    expect(positionalTrackKey(t, 0)).not.toBe(positionalTrackKey(t, 1));
  });

  test("プレイリスト詳細で重複 key 警告を出さずに 2 行描画する", async () => {
    setTestConnection();
    const dup = makeTrack({ trackId: 5, name: "Twice" });
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/tracks")) return jsonResponse([dup, dup]);
      return jsonResponse({ playlistId: 7, name: "Dup List", trackCount: 2 });
    }) as unknown as typeof fetch;
    (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "7" });
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await render(<PlaylistScreen />, { wrapper: createQueryWrapper() });
    expect(await screen.findAllByText("Twice")).toHaveLength(2);
    expect(error.mock.calls.some((c) => /same key/i.test(String(c[0])))).toBe(false);
    (useLocalSearchParams as jest.Mock).mockReturnValue({});
  });
});

describe("N7 API エラー本文（JSON）の文言を取り出して日本語化", () => {
  test("extractErrorBodyMessage", () => {
    expect(extractErrorBodyMessage('{"error":"No audio output available"}')).toBe("No audio output available");
    expect(extractErrorBodyMessage('{"message":"x"}')).toBe("x");
    expect(extractErrorBodyMessage("plain text")).toBe("plain text");
    expect(extractErrorBodyMessage("{broken")).toBe("{broken");
  });

  test("ApiError.message は JSON の中身、既知の英語は日本語、日本語はそのまま、未知は種別の文言", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ error: "No audio output available" }, 500),
    ) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://h:1", token: null });
    const err = await client.remotePlay(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("No audio output available");
    expect(describeApiError(err)).toBe("デスクトップで音声出力が見つかりません（出力デバイスを確認してください）");
    expect(describeApiError(err, { action: "再生" })).toMatch(/^再生に失敗しました: デスクトップで音声出力/);

    expect(serverErrorMessage(new ApiError(500, "音声出力が見つかりません"))).toBe("音声出力が見つかりません");
    expect(describeApiError(new ApiError(500, "something exploded"))).toBe(
      "デスクトップ側でエラーが発生しました（HTTP 500）",
    );
    // 401 は本文に関わらずトークンの案内。
    expect(describeApiError(new ApiError(401, "音声出力が見つかりません"))).toMatch(/トークンが違います/);
  });

  test("デスクトップで再生の失敗トーストに生 JSON を出さない", async () => {
    setTestConnection();
    global.fetch = jest.fn(async () =>
      jsonResponse({ error: "No audio output available" }, 500),
    ) as unknown as typeof fetch;
    await playOnDesktop([makeTrack()], 0);
    const msg = useToast.getState().message ?? "";
    expect(msg).toBe("デスクトップで再生できませんでした: デスクトップで音声出力が見つかりません（出力デバイスを確認してください）");
    expect(msg).not.toMatch(/[{}"]/);
  });
});

describe("N8 接続画面の URL 案内", () => {
  test("placeholder にポートを固定せず、表示場所を案内する", async () => {
    await render(<ConnectScreen />);
    const input = screen.getByLabelText("サーバー URL");
    expect(String(input.props.placeholder)).not.toMatch(/8787/);
    expect(screen.getByText(/設定 → モバイル \/ API」に表示された URL を入力してください/)).toBeTruthy();
  });
});
