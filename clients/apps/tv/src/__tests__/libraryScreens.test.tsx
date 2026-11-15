// TV のライブラリ画面（アルバム / アーティスト / 検索）の配線テスト。
// 一覧の並び順と、検索語の最小長（CJK は 1 文字から）を画面レベルで固定する。

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

import { type Album, type Artist, ApiClient, useConnection } from "@crateforge/core";

// Focusable は reanimated に依存するので、ラベルを持つだけの View に差し替える。
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock("@/components/focus", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Focusable: ({ children, accessibilityLabel }: { children: ReactNode; accessibilityLabel?: string }) =>
      React.createElement(View, { accessibilityLabel, accessible: true }, children),
  };
});

import AlbumsScreen from "../app/albums";
import ArtistsScreen from "../app/artists";
import SearchScreen from "../app/search";

/** URL のパスごとに応答を返す fetch モック。呼ばれた URL を記録する。 */
function mockApi(routes: Record<string, unknown>) {
  const urls: string[] = [];
  jest.spyOn(global, "fetch").mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    const path = new URL(url).pathname;
    const body = routes[path] ?? [];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);
  });
  return urls;
}

function renderScreen(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const album = (name: string, albumArtist: string | null, id: number): Album => ({
  album: name,
  albumArtist,
  trackCount: 1,
  sampleTrackId: id,
});

const artist = (name: string, id: number): Artist => ({ artist: name, trackCount: 1, sampleTrackId: id });

/** 「…, N曲」というラベルの行（アルバム行 / アーティスト行）の名前を表示順に返す。 */
function rowNames(screen: Awaited<ReturnType<typeof render>>): string[] {
  return screen
    .getAllByLabelText(/曲$/)
    .map((el) => String(el.props.accessibilityLabel).replace(/, .*$/, ""));
}

beforeEach(() => {
  useConnection.setState({
    client: new ApiClient({ baseUrl: "http://host:8787", token: null }),
    status: "connected",
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  useConnection.setState({ client: null, status: "idle" });
});

describe("TV アルバム一覧の並び順", () => {
  test("名前の自然順（mobile と同じ）。不明なアルバムは末尾", async () => {
    mockApi({
      "/api/albums": [
        album("Zeta", "Alpha", 1),
        album("", null, 2),
        album("Beta", "Bravo", 3),
        album("Alpha LP", "Alpha", 4),
        album("Middle", null, 5),
        album("Track 10", "Zed", 6),
        album("track 2", "Zed", 7),
      ],
    });
    const screen = await renderScreen(<AlbumsScreen />);
    await waitFor(() => expect(screen.getByText("Zeta")).toBeTruthy());
    expect(rowNames(screen)).toEqual([
      "Alpha LP",
      "Beta",
      "Middle",
      "track 2",
      "Track 10",
      "Zeta",
      "不明なアルバム",
    ]);
  });
});

describe("TV アーティスト一覧の並び順", () => {
  test("名前の自然順（mobile と同じ）。不明なアーティストは末尾", async () => {
    mockApi({
      "/api/artists": [artist("Zed", 1), artist("", 2), artist("abba", 3), artist("Artist 10", 4), artist("Artist 2", 5)],
    });
    const screen = await renderScreen(<ArtistsScreen />);
    await waitFor(() => expect(screen.getByText("Zed")).toBeTruthy());
    expect(rowNames(screen)).toEqual(["abba", "Artist 2", "Artist 10", "Zed", "不明なアーティスト"]);
  });
});

describe("TV 検索の最小長", () => {
  const DEBOUNCE_MS = 300;
  const wait = (ms: number) => act(async () => new Promise<void>((r) => setTimeout(r, ms)));

  async function type(text: string) {
    const urls = mockApi({ "/api/tracks": [] });
    const screen = await renderScreen(<SearchScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("検索"), text);
    });
    await wait(DEBOUNCE_MS + 100);
    return { urls, screen };
  }

  test("CJK は 1 文字で問い合わせる", async () => {
    const { urls } = await type("あ");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/api/tracks");
    expect(new URL(urls[0]).searchParams.get("q")).toBe("あ");
  });

  test("英数字 1 文字では問い合わせない（案内のまま）", async () => {
    const { urls, screen } = await type("a");
    expect(urls).toEqual([]);
    expect(screen.getByText("曲名・アーティスト名で検索してください")).toBeTruthy();
  });

  test("英数字は 2 文字から問い合わせる", async () => {
    const { urls } = await type("ab");
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("q")).toBe("ab");
  });
});
