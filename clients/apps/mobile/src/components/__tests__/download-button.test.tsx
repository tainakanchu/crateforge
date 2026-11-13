// DownloadButton の表示テスト。行内（単曲モード）では状態ラベルを画面に出さず a11y ラベルのみ、
// 明示 label prop を渡したときだけ文字を出す（round-2 M2 回帰: ローカル変数が prop を隠していた）。

import { render, screen } from "@testing-library/react-native";

import { type Track } from "@crateforge/core";
import DownloadButton from "@/components/DownloadButton";
import { resetTestState } from "@/test-utils";

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

beforeEach(() => {
  resetTestState();
});

describe("DownloadButton row mode", () => {
  test("does not render visible label text (a11y label only)", async () => {
    await render(<DownloadButton track={makeTrack()} />);
    const btn = screen.getByLabelText("ダウンロード");
    expect(btn).toBeTruthy();
    // 画面上の文字（Text）は出さない。
    expect(screen.queryByText("ダウンロード")).toBeNull();
    expect(screen.queryByText(/ダウンロード/)).toBeNull();
  });

  test("renders the label prop as text only when given", async () => {
    await render(<DownloadButton track={makeTrack()} label="保存" />);
    expect(screen.getByText("保存")).toBeTruthy();
    expect(screen.getByLabelText("ダウンロード")).toBeTruthy();
  });
});
