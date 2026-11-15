// core/src/lib/artPlaceholder.ts のテスト（core に jest 設定が無いため mobile のテストツリーに置く）。

import { placeholderColor, placeholderInitial } from "@crateforge/core";

describe("placeholderInitial", () => {
  it("先頭の 1 文字を大文字で返す", () => {
    expect(placeholderInitial("daft punk")).toBe("D");
    expect(placeholderInitial("  abba")).toBe("A");
    expect(placeholderInitial("宇多田ヒカル")).toBe("宇");
  });

  it("サロゲートペアを割らない", () => {
    expect(placeholderInitial("😀 mix")).toBe("😀");
  });

  it("空名は ♪", () => {
    expect(placeholderInitial("")).toBe("♪");
    expect(placeholderInitial("   ")).toBe("♪");
    expect(placeholderInitial(null)).toBe("♪");
    expect(placeholderInitial(undefined)).toBe("♪");
  });
});

describe("placeholderColor", () => {
  it("同じ名前は常に同じ色、前後の空白は無視する", () => {
    expect(placeholderColor("Daft Punk")).toBe(placeholderColor("Daft Punk"));
    expect(placeholderColor(" Daft Punk ")).toBe(placeholderColor("Daft Punk"));
  });

  it("文字列ハッシュ (h*31 + code) の色相を hsl で返す", () => {
    expect(placeholderColor("")).toBe("hsl(0, 32%, 30%)");
    expect(placeholderColor(null)).toBe("hsl(0, 32%, 30%)");
    // "A" = 65, "AB" = 65*31 + 66 = 2081 → 2081 % 360 = 281
    expect(placeholderColor("A")).toBe("hsl(65, 32%, 30%)");
    expect(placeholderColor("AB")).toBe("hsl(281, 32%, 30%)");
  });
});
