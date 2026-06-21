// ConnectScreen のスモークテスト。
// "ペアリング開始" ボタン押下後に pairStart が呼ばれ、コードが表示されることを確認する。
// @testing-library/react-native v14 では render() が Promise を返すため await が必要。

import React from "react";
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";

// SafeAreaProvider のモック（react-native-safe-area-context は jest 環境で必要）
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaView: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement(View, props, children),
    SafeAreaProvider: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement(View, props, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// useConnection のモック（モジュールレベルで固定）
const mockConnect = jest.fn(async (_url: string, _token: string | null) => true);

jest.mock("@crateforge/core", () => {
  const actual = jest.requireActual<typeof import("@crateforge/core")>("@crateforge/core");
  return {
    ...actual,
    useConnection: Object.assign(
      (selector: (s: { status: string }) => unknown) =>
        selector({ status: "idle" }),
      {
        getState: () => ({
          connect: mockConnect,
          hydrate: jest.fn(async () => undefined),
          status: "idle" as const,
        }),
      },
    ),
  };
});

import ConnectScreen from "../app/connect";

function setupFetchMock(responses: Array<{ body: unknown; status?: number }>) {
  let callIndex = 0;
  return jest.spyOn(global, "fetch").mockImplementation(() => {
    const idx = Math.min(callIndex, responses.length - 1);
    const { body, status = 200 } = responses[idx];
    callIndex++;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);
  });
}

// テキストを入力してから非同期でボタンを押すヘルパー。
// changeText の state 更新が useCallback の再生成より先に完了するよう
// 別々の act ブロックで実行する。
async function typeAndPress(
  screen: Awaited<ReturnType<typeof render>>,
  placeholder: string,
  value: string,
  buttonLabel: string,
) {
  // 1. テキスト入力（state 更新 + re-render を確定させる）
  await act(async () => {
    fireEvent.changeText(screen.getByPlaceholderText(placeholder), value);
  });
  // 2. ボタン押下（更新された useCallback を使う）
  await act(async () => {
    fireEvent.press(screen.getByText(buttonLabel));
  });
}

describe("ConnectScreen", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    jest.restoreAllMocks();
  });

  it("初期状態でアドレス入力とボタンが表示される", async () => {
    const screen = await render(<ConnectScreen />);

    expect(screen.getByPlaceholderText("192.168.1.10:8787")).toBeTruthy();
    expect(screen.getByText("ペアリング開始")).toBeTruthy();
  });

  it("アドレスが空の場合エラーメッセージが表示される", async () => {
    const screen = await render(<ConnectScreen />);

    // アドレスを空のまま送信
    await act(async () => {
      fireEvent.press(screen.getByText("ペアリング開始"));
    });

    await waitFor(() => {
      expect(screen.getByText(/IP:port を入力してください/)).toBeTruthy();
    });
  });

  it("ペアリング開始後にコードが大きく表示される", async () => {
    setupFetchMock([
      { body: { session: "sess-test", code: "654321" } },
      { body: { status: "pending" } },
    ]);

    const screen = await render(<ConnectScreen />);

    await typeAndPress(screen, "192.168.1.10:8787", "192.168.1.10:8787", "ペアリング開始");

    // コードが画面に表示されるのを待つ
    await waitFor(() => {
      expect(screen.getByText("654321")).toBeTruthy();
    });

    // 説明テキストも表示される
    expect(screen.getByText(/デスクトップで承認してください/)).toBeTruthy();
  });

  it("pairPoll が approved を返すと connect が呼ばれる", async () => {
    jest.useFakeTimers();

    try {
      setupFetchMock([
        { body: { session: "sess-ok", code: "111222" } },
        { body: { status: "approved", token: "tok-abc" } },
      ]);

      const screen = await render(<ConnectScreen />);

      await typeAndPress(screen, "192.168.1.10:8787", "192.168.1.10:8787", "ペアリング開始");

      // コードが表示されるのを待つ
      await waitFor(() => {
        expect(screen.getByText("111222")).toBeTruthy();
      });

      // タイマーを進めてポーリングを実行し、approved レスポンスを処理させる
      await act(async () => {
        jest.advanceTimersByTime(2500);
        // Promise の微小解決を待つ
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // connect() には正規化前の生アドレスを渡す（正規化は useConnection.connect 内で行う）
      await waitFor(() => {
        expect(mockConnect).toHaveBeenCalledWith("192.168.1.10:8787", "tok-abc");
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
