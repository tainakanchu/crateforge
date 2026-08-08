// レーティング衝突判定の単体テスト。

import { formatRatingConflict, resolveRatingConflict } from "../conflict";

describe("resolveRatingConflict", () => {
  it("base と同じなら apply", () => {
    expect(resolveRatingConflict(80, 80, 100)).toBe("apply");
    expect(resolveRatingConflict(null, null, 60)).toBe("apply");
  });

  it("既に目的値なら apply（冪等）", () => {
    expect(resolveRatingConflict(100, 80, 100)).toBe("apply");
    expect(resolveRatingConflict(0, 40, 0)).toBe("apply");
  });

  it("サーバが別値に変わっていたら conflict", () => {
    expect(resolveRatingConflict(60, 80, 100)).toBe("conflict");
    expect(resolveRatingConflict(20, null, 100)).toBe("conflict");
    expect(resolveRatingConflict(null, 40, 80)).toBe("conflict");
  });

  it("null と 0 は別物として扱う", () => {
    // base null / current 0 → サーバ側で 0 に変わった → conflict
    expect(resolveRatingConflict(0, null, 80)).toBe("conflict");
  });
});

describe("formatRatingConflict", () => {
  it("星表示を要約する", () => {
    const s = formatRatingConflict(100, 60);
    expect(s.localStars).toBe(5);
    expect(s.serverStars).toBe(3);
    expect(s.label).toContain("★★★★★");
    expect(s.label).toContain("★★★");
  });

  it("未設定を扱う", () => {
    const s = formatRatingConflict(0, null);
    expect(s.localStars).toBe(0);
    expect(s.serverStars).toBe(0);
    expect(s.label).toContain("未設定");
  });
});
