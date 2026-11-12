// round-2 の UI 修正の回帰テスト（M3 / M4 / M10 / M11 / M12）。

import { StyleSheet } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { type Track, describePlaybackError, useConnection } from "@crateforge/core";
import ConnectionNotice from "@/components/ConnectionNotice";
import LayeredArtwork from "@/components/LayeredArtwork";
import ModeToggleButton, { MODE_ON_BG } from "@/components/ModeToggleButton";
import RatingStars from "@/components/RatingStars";
import { useActionSheet } from "@/components/ActionSheet";
import GenreChips from "@/features/browse/GenreChips";
import { playTrackOnDesktop } from "@/features/playback/desktopPlay";
import { resetTestState, setTestConnection } from "@/test-utils";

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
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  resetTestState();
  useActionSheet.setState({ current: null });
});

describe("GenreChips (M3)", () => {
  test("横 ScrollView 自体を縮ませない（flexShrink:0）", async () => {
    await render(<GenreChips genres={[{ tag: "House", count: 3 }]} selected={null} onSelect={() => {}} />);
    const scroll = screen.getByTestId("genre-chips");
    const style = StyleSheet.flatten(scroll.props.style);
    expect(style.flexShrink).toBe(0);
    expect(style.flexGrow).toBe(0);
  });
});

describe("LayeredArtwork (M4)", () => {
  test("画像の下に頭文字プレースホルダを敷き、読み込み失敗で画像を外す", async () => {
    await render(<LayeredArtwork source={{ uri: "http://h/art/1" }} name="Blue Train" size={48} radius={6} />);
    // プレースホルダ（頭文字）は常にある。
    expect(screen.getByText("B", { includeHiddenElements: true })).toBeTruthy();
    const img = screen.getByTestId("artwork-image");
    // 画像側に背景色を付けない（付けると 404 時にプレースホルダを覆う）。
    expect(StyleSheet.flatten(img.props.style).backgroundColor).toBeUndefined();
    await act(async () => {
      img.props.onError?.({ error: "404" });
    });
    expect(screen.queryByTestId("artwork-image")).toBeNull();
    expect(screen.getByText("B", { includeHiddenElements: true })).toBeTruthy();
  });

  test("source が無ければプレースホルダのみ", async () => {
    await render(<LayeredArtwork source={null} name="kind of blue" size={48} radius={6} />);
    expect(screen.getByText("K", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId("artwork-image")).toBeNull();
  });
});

describe("ModeToggleButton (M10)", () => {
  test("オン時は塗り背景", async () => {
    await render(
      <ModeToggleButton icon="shuffle" active onPress={() => {}} accessibilityLabel="シャッフル（オン）" />,
    );
    const on = screen.getByLabelText("シャッフル（オン）");
    expect(StyleSheet.flatten(on.props.style).backgroundColor).toBe(MODE_ON_BG);
    expect(on.props.accessibilityState).toMatchObject({ selected: true });
  });

  test("オフ時は背景なし", async () => {
    await render(
      <ModeToggleButton icon="shuffle" active={false} onPress={() => {}} accessibilityLabel="シャッフル（オフ）" />,
    );
    const off = screen.getByLabelText("シャッフル（オフ）");
    expect(StyleSheet.flatten(off.props.style).backgroundColor).toBeUndefined();
  });
});

describe("RatingStars (M12)", () => {
  test("increment / decrement の accessibilityActions で 0.5 刻みに増減する", async () => {
    const onChange = jest.fn();
    await render(<RatingStars value={3} onChange={onChange} size={26} />);
    const slider = screen.getByLabelText("評価");
    expect(slider.props.accessibilityActions).toEqual([{ name: "increment" }, { name: "decrement" }]);
    slider.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
    expect(onChange).toHaveBeenLastCalledWith(3.5);
    slider.props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
  });

  test("半星のタップ領域は 20px 以上", async () => {
    await render(<RatingStars value={0} onChange={() => {}} size={26} />);
    // 星の箱 = size + 18 → 半分で 22px。
    const half = screen.getByLabelText("星0.5");
    const parentBox = half.parent?.parent;
    expect(parentBox).toBeTruthy();
    const boxWidth = StyleSheet.flatten(parentBox!.props.style).width as number;
    expect(boxWidth / 2).toBeGreaterThanOrEqual(20);
  });
});

describe("describePlaybackError (M12)", () => {
  test("Playback error (code 4) を日本語にする", () => {
    expect(describePlaybackError("Playback error (code 4)")).toMatch(/再生できませんでした/);
    expect(describePlaybackError("Playback error (code 4)")).not.toMatch(/code/);
    expect(describePlaybackError("Source error")).toMatch(/対応していない形式/);
    expect(describePlaybackError("オフラインのため再生できません（未ダウンロード）")).toBe(
      "オフラインのため再生できません（未ダウンロード）",
    );
  });
});

describe("1 曲のデスクトップで再生 (M11)", () => {
  test("デスクトップのキューに曲があるときは置き換え前に確認する", async () => {
    setTestConnection();
    const fetchMock = jest.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/remote/queue")) return jsonResponse({ trackIds: [1, 2, 3], currentIndex: 0 });
      return jsonResponse(null, 204);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await playTrackOnDesktop(makeTrack({ trackId: 9 }));
    const sheet = useActionSheet.getState().current;
    expect(sheet?.subtitle).toMatch(/3曲/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/remote/set-queue"))).toBe(false);

    // 「今すぐ再生（キューを置き換え）」を選ぶと置き換えて再生する。
    sheet!.actions[0].onPress?.();
    await act(async () => {});
    const setQueue = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/remote/set-queue"));
    expect(setQueue).toBeTruthy();
    expect(JSON.parse(String(setQueue![1]?.body))).toMatchObject({ trackIds: [9], play: true });
  });

  test("キューが空なら確認なしで再生する", async () => {
    setTestConnection();
    const fetchMock = jest.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/remote/queue")) return jsonResponse({ trackIds: [], currentIndex: null });
      return jsonResponse(null, 204);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await playTrackOnDesktop(makeTrack({ trackId: 9 }));
    expect(useActionSheet.getState().current).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/remote/set-queue"))).toBe(true);
  });
});

describe("ConnectionNotice 再試行 (M6)", () => {
  test("オフラインでは「再試行」で recheck する", async () => {
    useConnection.setState({ baseUrl: "http://h:1", status: "error", errorKind: "network", client: null });
    const recheck = jest.spyOn(useConnection.getState(), "recheck").mockResolvedValue(false);
    await render(<ConnectionNotice />);
    expect(screen.getByText(/デスクトップに届きません/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText("再試行"));
    expect(recheck).toHaveBeenCalled();
  });
});
