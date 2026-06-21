import {
  formatDuration,
  formatSeconds,
  ratingToStars,
  trackArtist,
  trackMetaText,
  trackSubtitle,
  trackTitle,
} from "@crateforge/core";

describe("formatDuration", () => {
  it("formats mm:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(600_000)).toBe("10:00");
  });
  it("formats h:mm:ss past an hour", () => {
    expect(formatDuration(3_661_000)).toBe("1:01:01");
  });
  it("guards null / negative / NaN", () => {
    expect(formatDuration(null)).toBe("0:00");
    expect(formatDuration(undefined)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });
});

describe("formatSeconds", () => {
  it("rounds seconds to mm:ss", () => {
    expect(formatSeconds(0)).toBe("0:00");
    expect(formatSeconds(65.4)).toBe("1:05");
    expect(formatSeconds(null)).toBe("0:00");
  });
});

describe("ratingToStars", () => {
  it("maps 0-100 to 0-5 stars", () => {
    expect(ratingToStars(0)).toBe(0);
    expect(ratingToStars(80)).toBe(4);
    expect(ratingToStars(100)).toBe(5);
    expect(ratingToStars(50)).toBe(3); // 2.5 -> round -> 3 (banker? Math.round -> 3)
  });
  it("guards null and clamps", () => {
    expect(ratingToStars(null)).toBe(0);
    expect(ratingToStars(200)).toBe(5);
    expect(ratingToStars(-10)).toBe(0);
  });
});

describe("track display helpers", () => {
  it("trackTitle falls back to filename then Unknown", () => {
    expect(trackTitle({ name: "Song", locationPath: null })).toBe("Song");
    expect(trackTitle({ name: null, locationPath: "/music/a/b/cool.mp3" })).toBe("cool.mp3");
    expect(trackTitle({ name: "  ", locationPath: "C:\\m\\x.flac" })).toBe("x.flac");
    expect(trackTitle({ name: null, locationPath: null })).toBe("Unknown Track");
  });
  it("trackArtist prefers artist then albumArtist", () => {
    expect(trackArtist({ artist: "A", albumArtist: "B" })).toBe("A");
    expect(trackArtist({ artist: null, albumArtist: "B" })).toBe("B");
    expect(trackArtist({ artist: null, albumArtist: null })).toBe("Unknown Artist");
  });
  it("trackSubtitle joins artist and album", () => {
    expect(trackSubtitle({ artist: "A", albumArtist: null, album: "Alb" })).toBe("A — Alb");
    expect(trackSubtitle({ artist: null, albumArtist: "B", album: null })).toBe("B");
    expect(trackSubtitle({ artist: null, albumArtist: null, album: null })).toBe("Unknown Artist");
  });
});

describe("trackMetaText", () => {
  const baseTrack = {
    bpm: null as number | null,
    year: null as number | null,
    genre: null as string | null,
    rating: null as number | null,
    playCount: null as number | null,
  };

  it("bpm フィールド: 値ありで '128 BPM'", () => {
    expect(trackMetaText({ ...baseTrack, bpm: 128 }, "bpm")).toBe("128 BPM");
  });

  it("bpm フィールド: null なら null", () => {
    expect(trackMetaText({ ...baseTrack, bpm: null }, "bpm")).toBeNull();
  });

  it("year フィールド: 値ありで文字列化", () => {
    expect(trackMetaText({ ...baseTrack, year: 2020 }, "year")).toBe("2020");
  });

  it("year フィールド: null なら null", () => {
    expect(trackMetaText({ ...baseTrack, year: null }, "year")).toBeNull();
  });

  it("genre フィールド: 空文字は null", () => {
    expect(trackMetaText({ ...baseTrack, genre: "" }, "genre")).toBeNull();
    expect(trackMetaText({ ...baseTrack, genre: "Jazz" }, "genre")).toBe("Jazz");
  });

  it("rating フィールド: 80 = ★★★★", () => {
    expect(trackMetaText({ ...baseTrack, rating: 80 }, "rating")).toBe("★★★★");
  });

  it("rating フィールド: 0 は null", () => {
    expect(trackMetaText({ ...baseTrack, rating: 0 }, "rating")).toBeNull();
  });

  it("playCount フィールド: 5 回なら '▶ 5'", () => {
    expect(trackMetaText({ ...baseTrack, playCount: 5 }, "playCount")).toBe("▶ 5");
  });

  it("playCount フィールド: 0 は null", () => {
    expect(trackMetaText({ ...baseTrack, playCount: 0 }, "playCount")).toBeNull();
  });
});
