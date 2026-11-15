// ModalToastHost: iOS のモーダル画面の中だけにトーストの表示先を置く。

import React from "react";
import { Platform } from "react-native";
import { act, render } from "@testing-library/react-native";

import ModalToastHost from "@/components/ModalToastHost";
import { showToast, useToast } from "@/components/Toast";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const originalOS = Platform.OS;

function setOS(os: typeof Platform.OS) {
  Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
}

afterEach(() => {
  setOS(originalOS);
  useToast.setState({ message: null, kind: "info" });
});

describe("ModalToastHost", () => {
  test("iOS ではモーダルの中にトーストを出す", async () => {
    setOS("ios");
    const screen = await render(<ModalToastHost />);
    await act(async () => {
      showToast("評価を保存できませんでした（理由）", "error");
    });
    expect(screen.getByText("評価を保存できませんでした（理由）")).toBeTruthy();
  });

  test("Android では出さない（ルートの ToastHost と二重にしない）", async () => {
    setOS("android");
    const screen = await render(<ModalToastHost />);
    await act(async () => {
      showToast("評価を保存できませんでした（理由）", "error");
    });
    expect(screen.queryByText("評価を保存できませんでした（理由）")).toBeNull();
  });
});
