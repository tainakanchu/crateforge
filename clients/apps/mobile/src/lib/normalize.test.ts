import {
  hasCjk,
  isSearchable,
  matchesNormalized,
  naturalCompare,
  normalizeSearchText,
} from "@/lib/normalize";

describe("normalizeSearchText", () => {
  it("全角英数と半角を同一視する", () => {
    expect(normalizeSearchText("ＡＢＣ１２３")).toBe(normalizeSearchText("abc123"));
  });
  it("ひらがなとカタカナを同一視する", () => {
    expect(normalizeSearchText("ぼかろ")).toBe(normalizeSearchText("ボカロ"));
  });
  it("半角カナを全角カナに寄せる", () => {
    expect(normalizeSearchText("ﾎﾞｶﾛ")).toBe(normalizeSearchText("ボカロ"));
  });
  it("大小・空白・記号を無視する", () => {
    expect(normalizeSearchText("Hello, World!")).toBe(normalizeSearchText("helloworld"));
    expect(normalizeSearchText("A-ha")).toBe("aha");
    expect(normalizeSearchText("宇多田・ヒカル")).toBe(normalizeSearchText("宇多田ヒカル"));
  });
  it("長音は残す", () => {
    expect(normalizeSearchText("ビートルズー")).toContain("ー");
  });
  it("null / undefined は空文字", () => {
    expect(normalizeSearchText(null)).toBe("");
    expect(normalizeSearchText(undefined)).toBe("");
  });
});

describe("matchesNormalized", () => {
  it("表記ゆれを吸収して部分一致する", () => {
    expect(matchesNormalized("Ｙｅｌｌｏｗ Ｍｏｎｋｅｙ", "yellow")).toBe(true);
    expect(matchesNormalized("きゃりーぱみゅぱみゅ", "キャリー")).toBe(true);
    expect(matchesNormalized("Radiohead", "head")).toBe(true);
    expect(matchesNormalized("Radiohead", "xyz")).toBe(false);
  });
  it("空クエリは常に一致", () => {
    expect(matchesNormalized("abc", "")).toBe(true);
  });
});

describe("isSearchable / hasCjk", () => {
  it("CJK は 1 文字から検索可能", () => {
    expect(isSearchable("星")).toBe(true);
    expect(isSearchable("あ")).toBe(true);
    expect(isSearchable("ア")).toBe(true);
  });
  it("ASCII は 2 文字から", () => {
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable("ab")).toBe(true);
    expect(isSearchable("  ")).toBe(false);
  });
  it("hasCjk", () => {
    expect(hasCjk("abc")).toBe(false);
    expect(hasCjk("abc曲")).toBe(true);
  });
});

describe("naturalCompare", () => {
  it("数字を数として比較する", () => {
    const sorted = ["Bulk Artist 10", "Bulk Artist 2", "Bulk Artist 1"].sort(naturalCompare);
    expect(sorted).toEqual(["Bulk Artist 1", "Bulk Artist 2", "Bulk Artist 10"]);
  });
});
