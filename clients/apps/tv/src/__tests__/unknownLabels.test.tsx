// 不明なアーティスト / アルバム（API が artist: "" / album: "" で返すグループ）の TV 表示テスト。

import React from "react";
import { render } from "@testing-library/react-native";

jest.mock("@crateforge/core", () => {
  const actual = jest.requireActual<typeof import("@crateforge/core")>("@crateforge/core");
  return {
    ...actual,
    // 未接続（アートワークはプレースホルダ）。
    useConnection: (selector: (s: { client: null }) => unknown) => selector({ client: null }),
  };
});

// Focusable は reanimated に依存するので、ラベルを持つだけの View に差し替える。
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock("@/components/focus", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Focusable: ({ children, accessibilityLabel }: { children: React.ReactNode; accessibilityLabel?: string }) =>
      React.createElement(View, { accessibilityLabel, accessible: true }, children),
  };
});

import { AlbumRow } from "@/components/library/AlbumRow";
import { ArtistRow } from "@/components/library/ArtistRow";

describe("TV library rows: 空名のグループ", () => {
  test("空のアーティスト名は「不明なアーティスト」と表示する", async () => {
    const screen = await render(
      <ArtistRow artist={{ artist: "", trackCount: 3, sampleTrackId: 1 }} />,
    );
    expect(screen.getByText("不明なアーティスト")).toBeTruthy();
    expect(screen.getByLabelText("不明なアーティスト, 3曲")).toBeTruthy();
  });

  test("空のアルバム名は「不明なアルバム」と表示する", async () => {
    const screen = await render(
      <AlbumRow album={{ album: "", albumArtist: null, trackCount: 2, sampleTrackId: 1 }} />,
    );
    expect(screen.getByText("不明なアルバム")).toBeTruthy();
  });

  test("通常の名前はそのまま", async () => {
    const screen = await render(
      <ArtistRow artist={{ artist: "Daft Punk", trackCount: 1, sampleTrackId: 1 }} />,
    );
    expect(screen.getByText("Daft Punk")).toBeTruthy();
  });
});
