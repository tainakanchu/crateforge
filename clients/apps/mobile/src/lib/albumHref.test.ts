import { albumHref } from "./albumHref";

describe("albumHref", () => {
  it("albumArtist 無しは album のみ", () => {
    expect(albumHref("A B")).toBe("/album/A%20B");
    expect(albumHref("A", null)).toBe("/album/A");
    expect(albumHref("A", "")).toBe("/album/A");
  });
  it("albumArtist を query に付ける", () => {
    expect(albumHref("Dawn", "Foo & Bar")).toBe("/album/Dawn?albumArtist=Foo%20%26%20Bar");
  });
});
