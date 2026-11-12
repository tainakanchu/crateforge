import { albumHref } from "./albumHref";

describe("albumHref", () => {
  it("album 名のみ（albumArtist では絞らない = 一覧と同じ粒度）", () => {
    expect(albumHref("A B")).toBe("/album/A%20B");
    expect(albumHref("Foo & Bar / Mix")).toBe("/album/Foo%20%26%20Bar%20%2F%20Mix");
  });
});
