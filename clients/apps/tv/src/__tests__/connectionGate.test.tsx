// TV の接続ゲート（/connect ↔ / の振り分け）と、届かない間の帯のテスト。

import React, { type ReactNode } from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";

import { useConnection } from "@crateforge/core";

// Focusable は reanimated に依存するので、押せるだけの Pressable に差し替える。
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock("@/components/focus", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  return {
    Focusable: ({
      children,
      accessibilityLabel,
      onSelect,
    }: {
      children: ReactNode;
      accessibilityLabel?: string;
      onSelect?: () => void;
    }) => React.createElement(Pressable, { accessibilityLabel, onPress: onSelect }, children),
  };
});

import { ConnectionBanner } from "@/components/shell/ConnectionBanner";
import { gateTarget } from "@/lib/gate";

describe("gateTarget", () => {
  test("接続先が無い（idle）なら /connect へ", () => {
    expect(gateTarget({ status: "idle", offline: false, onConnect: false })).toBe("/connect");
    expect(gateTarget({ status: "idle", offline: false, onConnect: true })).toBeNull();
  });

  test("届かないだけ（offline）なら /connect へ飛ばさない", () => {
    expect(gateTarget({ status: "error", offline: true, onConnect: false })).toBeNull();
    // 自分で接続画面を開いているときもそのまま。
    expect(gateTarget({ status: "error", offline: true, onConnect: true })).toBeNull();
  });

  test("トークン不一致など入れ直しが必要なエラーは /connect へ", () => {
    expect(gateTarget({ status: "error", offline: false, onConnect: false })).toBe("/connect");
    expect(gateTarget({ status: "error", offline: false, onConnect: true })).toBeNull();
  });

  test("接続できたら /connect から / へ。それ以外の画面はそのまま", () => {
    expect(gateTarget({ status: "connected", offline: false, onConnect: true })).toBe("/");
    expect(gateTarget({ status: "connected", offline: false, onConnect: false })).toBeNull();
  });

  test("接続確認中は動かさない", () => {
    expect(gateTarget({ status: "connecting", offline: false, onConnect: false })).toBeNull();
    expect(gateTarget({ status: "connecting", offline: false, onConnect: true })).toBeNull();
  });
});

describe("ConnectionBanner", () => {
  afterEach(() => {
    useConnection.setState({ status: "idle", baseUrl: null, errorKind: null, error: null });
  });

  test("接続中は出さない", async () => {
    useConnection.setState({ status: "connected", baseUrl: "http://host:8787", errorKind: null });
    const screen = await render(<ConnectionBanner />);
    expect(screen.queryByText(/接続できません/)).toBeNull();
  });

  test("トークン不一致（届いてはいる）では出さない", async () => {
    useConnection.setState({ status: "error", baseUrl: "http://host:8787", errorKind: "unauthorized" });
    const screen = await render(<ConnectionBanner />);
    expect(screen.queryByText(/接続できません/)).toBeNull();
  });

  test("届かない間は知らせ、「接続し直す」で接続画面へ行ける", async () => {
    useConnection.setState({ status: "error", baseUrl: "http://host:8787", errorKind: "network" });
    const screen = await render(<ConnectionBanner />);
    expect(screen.getByText("デスクトップに接続できません。自動で再接続を試しています…")).toBeTruthy();
    (router.push as jest.Mock).mockClear();
    fireEvent.press(screen.getByLabelText("接続し直す"));
    expect(router.push).toHaveBeenCalledWith("/connect");
  });
});
