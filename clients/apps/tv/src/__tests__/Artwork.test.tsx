// TV 共通 Artwork（画像 + 頭文字プレースホルダ）のテスト。

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";

let mockClient: { artworkSource: (trackId: number) => { uri: string } } | null = null;

jest.mock("@crateforge/core", () => {
  const actual = jest.requireActual<typeof import("@crateforge/core")>("@crateforge/core");
  return {
    ...actual,
    useConnection: (selector: (s: { client: unknown }) => unknown) => selector({ client: mockClient }),
  };
});

import { Artwork } from "@/components/Artwork";

const connected = () => {
  mockClient = { artworkSource: (trackId) => ({ uri: `http://host/api/tracks/${trackId}/artwork` }) };
};

// プレースホルダは読み上げ対象から外してあるので、検索では隠し要素も含める。
const HIDDEN = { includeHiddenElements: true };

beforeEach(() => {
  mockClient = null;
});

describe("TV Artwork", () => {
  test("未接続なら画像を出さず、頭文字プレースホルダを出す", async () => {
    const screen = await render(<Artwork trackId={1} name="daft punk" size={64} radius={6} />);
    expect(screen.getByText("D", HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId("artwork-image", HIDDEN)).toBeNull();
  });

  test("接続中は頭文字の上に画像を重ねる", async () => {
    connected();
    const screen = await render(<Artwork trackId={7} name="Album" size={64} radius={6} />);
    expect(screen.getByText("A", HIDDEN)).toBeTruthy();
    expect(screen.getByTestId("artwork-image", HIDDEN).props.source).toEqual({
      uri: "http://host/api/tracks/7/artwork",
    });
  });

  test("読み込みに失敗（404 = アート無し等）したら画像を外して頭文字だけにする", async () => {
    connected();
    const screen = await render(<Artwork trackId={7} name="Album" size={64} radius={6} />);
    await act(async () => {
      fireEvent(screen.getByTestId("artwork-image", HIDDEN), "error");
    });
    expect(screen.queryByTestId("artwork-image", HIDDEN)).toBeNull();
    expect(screen.getByText("A", HIDDEN)).toBeTruthy();
  });

  test("曲が変われば失敗後でも画像を再試行する", async () => {
    connected();
    const screen = await render(<Artwork trackId={7} name="Album" size={64} radius={6} />);
    await act(async () => {
      fireEvent(screen.getByTestId("artwork-image", HIDDEN), "error");
    });
    await screen.rerender(<Artwork trackId={8} name="Other" size={64} radius={6} />);
    expect(screen.getByTestId("artwork-image", HIDDEN).props.source).toEqual({
      uri: "http://host/api/tracks/8/artwork",
    });
    expect(screen.getByText("O", HIDDEN)).toBeTruthy();
  });

  test("空名は ♪", async () => {
    const screen = await render(<Artwork trackId={1} name="" size={64} radius={6} />);
    expect(screen.getByText("♪", HIDDEN)).toBeTruthy();
  });
});
