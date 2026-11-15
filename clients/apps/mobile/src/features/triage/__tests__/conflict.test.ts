// レーティング衝突判定の単体テスト。

import { formatRatingConflict, resolveRatingConflict } from "../conflict";
import { describePendingOp, ratingLabel } from "../labels";

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

  it("半星を保つ（70 → 3.5 / ★★★½）", () => {
    const s = formatRatingConflict(70, 50);
    expect(s.localStars).toBe(3.5);
    expect(s.serverStars).toBe(2.5);
    expect(s.label).toBe("端末 ★★★½ / サーバ ★★½");
  });

  it("未設定を扱う", () => {
    const s = formatRatingConflict(0, null);
    expect(s.localStars).toBe(0);
    expect(s.serverStars).toBe(0);
    expect(s.label).toContain("未設定");
  });
});

describe("ratingLabel / describePendingOp（保留一覧と衝突カードで同じ表記）", () => {
  const base = { id: "x", createdAt: "2026-11-15T00:00:00Z", trackId: 7 };

  it("★ の個数 + 半星は ½（曲行・長押しメニューと同じ core の表記）", () => {
    expect(ratingLabel(100)).toBe("★★★★★");
    expect(ratingLabel(70)).toBe("★★★½");
    expect(ratingLabel(10)).toBe("½");
  });

  it("0 / 未設定は「未設定」", () => {
    expect(ratingLabel(0)).toBe("未設定");
    expect(ratingLabel(null)).toBe("未設定");
    expect(ratingLabel(undefined)).toBe("未設定");
  });

  it("保留中の評価は衝突カードと同じ表記で出す", () => {
    const op = { ...base, kind: "rating" as const, rating: 70, baseRating: 40, trackName: "Song" };
    expect(describePendingOp(op)).toBe("★★★½ ← Song");
    expect(formatRatingConflict(70, 40).label).toBe("端末 ★★★½ / サーバ ★★");
    expect(describePendingOp({ ...op, rating: 0 })).toBe("未設定 ← Song");
  });

  it("タグ・あとで聴く・曲名なし", () => {
    expect(describePendingOp({ ...base, kind: "tag-add", tag: "mood:chill", trackName: "Song" })).toBe(
      "+mood:chill ← Song",
    );
    expect(describePendingOp({ ...base, kind: "tag-remove", tag: "mood:chill", trackName: null })).toBe(
      "-mood:chill ← #7",
    );
    expect(describePendingOp({ ...base, kind: "review-later" })).toBe("あとで ← #7");
  });
});
