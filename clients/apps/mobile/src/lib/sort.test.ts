// core/src/lib/sort.ts のテスト（core に jest 設定が無いため mobile のテストツリーに置く）。

import { byDiscTrack, compareAlbums, compareAlbumsByName, compareNamesUnknownLast } from "@crateforge/core";

describe("compareNamesUnknownLast", () => {
  const cmp = compareNamesUnknownLast((x: { name: string }) => x.name);
  const sorted = (names: string[]) =>
    names
      .map((name) => ({ name }))
      .sort(cmp)
      .map((x) => x.name);

  it("自然順（数値を数として扱い、大小を区別しない）", () => {
    expect(sorted(["Artist 10", "artist 2", "Artist 1"])).toEqual(["Artist 1", "artist 2", "Artist 10"]);
  });

  it("空名（不明）は常に末尾", () => {
    expect(sorted(["", "B", "A"])).toEqual(["A", "B", ""]);
    expect(sorted(["B", "  ", "A"])).toEqual(["A", "B", "  "]);
  });

  it("空名どうしは同順位", () => {
    expect(cmp({ name: "" }, { name: "" })).toBe(0);
  });
});

describe("compareAlbums", () => {
  const sorted = (albums: { album: string; albumArtist: string | null; year?: number | null }[]) =>
    [...albums].sort(compareAlbums).map((a) => a.album);

  it("アルバムアーティスト → アルバム名の順", () => {
    expect(
      sorted([
        { album: "Zeta", albumArtist: "Alpha" },
        { album: "Beta", albumArtist: "Bravo" },
        { album: "Alpha LP", albumArtist: "Alpha" },
      ]),
    ).toEqual(["Alpha LP", "Zeta", "Beta"]);
  });

  it("アルバムアーティストが無ければアルバム名で代用する", () => {
    expect(
      sorted([
        { album: "Middle", albumArtist: null },
        { album: "X", albumArtist: "Zed" },
        { album: "Y", albumArtist: "Abe" },
      ]),
    ).toEqual(["Y", "Middle", "X"]);
  });

  it("大文字小文字を区別しない", () => {
    expect(compareAlbums({ album: "a", albumArtist: "x" }, { album: "A", albumArtist: "X" })).toBe(0);
  });

  it("同名は年の昇順、年不明は最後", () => {
    const base = { album: "Same", albumArtist: "A" };
    expect(compareAlbums({ ...base, year: 1999 }, { ...base, year: 2005 })).toBeLessThan(0);
    expect(compareAlbums({ ...base, year: null }, { ...base, year: 2005 })).toBeGreaterThan(0);
    expect(compareAlbums({ ...base, year: 2005 }, { ...base })).toBeLessThan(0);
    expect(compareAlbums({ ...base }, { ...base, year: null })).toBe(0);
  });
});

describe("compareAlbumsByName（mobile / TV のアルバム一覧）", () => {
  const sorted = (albums: { album: string; albumArtist: string | null; year?: number | null }[]) =>
    [...albums].sort(compareAlbumsByName).map((a) => `${a.album}/${a.albumArtist ?? "-"}`);

  it("名前の自然順。不明なアルバムは末尾", () => {
    expect(
      sorted([
        { album: "Vol. 10", albumArtist: "A" },
        { album: "", albumArtist: null },
        { album: "vol. 2", albumArtist: "Z" },
        { album: "Alpha", albumArtist: "M" },
      ]),
    ).toEqual(["Alpha/M", "vol. 2/Z", "Vol. 10/A", "/-"]);
  });

  it("同名のアルバムはアルバムアーティスト順、さらに年の昇順", () => {
    expect(
      sorted([
        { album: "Greatest Hits", albumArtist: "Queen" },
        { album: "Greatest Hits", albumArtist: "ABBA" },
        { album: "Greatest Hits", albumArtist: null },
        { album: "Another", albumArtist: "Zed" },
      ]),
    ).toEqual(["Another/Zed", "Greatest Hits/ABBA", "Greatest Hits/-", "Greatest Hits/Queen"]);
    const same = { album: "Live", albumArtist: "X" };
    expect(compareAlbumsByName({ ...same, year: 1999 }, { ...same, year: 2005 })).toBeLessThan(0);
  });
});

describe("byDiscTrack", () => {
  it("disc → track の昇順。番号なしは 0 扱い", () => {
    const tracks = [
      { id: "d2t1", discNumber: 2, trackNumber: 1 },
      { id: "d1t2", discNumber: 1, trackNumber: 2 },
      { id: "none", discNumber: null, trackNumber: null },
      { id: "d1t1", discNumber: 1, trackNumber: 1 },
      { id: "t3", discNumber: null, trackNumber: 3 },
    ];
    expect([...tracks].sort(byDiscTrack).map((t) => t.id)).toEqual(["none", "t3", "d1t1", "d1t2", "d2t1"]);
  });
});
