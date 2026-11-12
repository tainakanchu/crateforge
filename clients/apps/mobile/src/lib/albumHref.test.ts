import { albumHref, artistHref, nameFromParams } from "./albumHref";

describe("albumHref", () => {
  it("album 名のみ（albumArtist では絞らない = 一覧と同じ粒度）", () => {
    expect(albumHref("A B")).toBe("/album/A%20B");
    expect(albumHref("Foo & Bar / Mix")).toBe("/album/Foo%20%26%20Bar%20%2F%20Mix");
  });

  it("空のアルバム名（不明なアルバム）は空セグメントにせず unknown=1 で表す", () => {
    expect(albumHref("")).toBe("/album/_?unknown=1");
    expect(albumHref("   ")).toBe("/album/_?unknown=1");
    expect(albumHref(null)).toBe("/album/_?unknown=1");
  });
});

describe("artistHref", () => {
  it("通常のアーティスト名はエンコードしてパスに載せる", () => {
    expect(artistHref("AC/DC")).toBe("/artist/AC%2FDC");
  });

  it("空のアーティスト名（不明なアーティスト）は unknown=1", () => {
    expect(artistHref("")).toBe("/artist/_?unknown=1");
    expect(artistHref(undefined)).toBe("/artist/_?unknown=1");
  });
});

describe("nameFromParams", () => {
  it("unknown=1 は空名（不明なグループ）として扱う", () => {
    expect(nameFromParams({ name: "_", unknown: "1" })).toBe("");
  });

  it("実在の \"_\" という名前とはフラグで区別する", () => {
    expect(nameFromParams({ name: "_" })).toBe("_");
  });

  it("通常はデコードした名前、name 無しは null", () => {
    expect(nameFromParams({ name: "A%20B" })).toBe("A B");
    expect(nameFromParams({})).toBeNull();
  });
});
