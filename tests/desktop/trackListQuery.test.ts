import { test } from "vitest";
import assert from "node:assert/strict";
import {
  albumScopeOf,
  resolveTrackListQuery,
  trackListGroupKey,
  trackListKey,
} from "../../src/lib/trackListQuery.ts";
import type { TrackListState } from "../../src/lib/trackListQuery.ts";

const base: TrackListState = {
  viewMode: "library",
  selectedPlaylistId: null,
  playlistIsSmart: false,
  searchQuery: "",
  searchScope: "playlist",
  filterTags: [],
  sortField: "artist",
  sortOrder: "asc",
};
const q = (over: Partial<TrackListState>) => resolveTrackListQuery({ ...base, ...over });

test("ライブラリ: 検索語なしは全曲、検索語 + 絞り込みタグは空白区切りの AND", () => {
  assert.deepEqual(q({}), { kind: "library", query: "", sortField: "artist", sortOrder: "asc" });
  assert.deepEqual(q({ searchQuery: "  daft ", filterTags: ["genre:House", "year:2001"] }), {
    kind: "library",
    query: "daft genre:House year:2001",
    sortField: "artist",
    sortOrder: "asc",
  });
});

test("Set History は一覧なし、Inbox / 最近再生した曲はメモリ上の一覧 (検索語は効かない)", () => {
  assert.deepEqual(q({ viewMode: "history" }), { kind: "none" });
  assert.deepEqual(q({ viewMode: "inbox", searchQuery: "x" }), { kind: "memory", source: "inbox" });
  assert.deepEqual(q({ viewMode: "recent", searchQuery: "x" }), { kind: "memory", source: "recent" });
});

test("通常プレイリスト: 手動順は sortField を渡さない。列で並べたらその並び", () => {
  const pl = { viewMode: "playlist" as const, selectedPlaylistId: 7 };
  assert.deepEqual(q({ ...pl, sortField: "playlistOrder" }), {
    kind: "playlist",
    playlistId: 7,
    smart: false,
    query: "",
  });
  assert.deepEqual(q({ ...pl, sortField: "bpm", sortOrder: "desc" }), {
    kind: "playlist",
    playlistId: 7,
    smart: false,
    query: "",
    sortField: "bpm",
    sortOrder: "desc",
  });
});

test("スマートプレイリスト: 手動順を持たないので playlistOrder は曲名の昇順に倒す", () => {
  assert.deepEqual(
    q({
      viewMode: "playlist",
      selectedPlaylistId: 7,
      playlistIsSmart: true,
      sortField: "playlistOrder",
      sortOrder: "desc",
    }),
    { kind: "playlist", playlistId: 7, smart: true, query: "", sortField: "name", sortOrder: "asc" },
  );
});

test("プレイリスト表示中の検索: スコープが「このプレイリスト」なら中だけ、「ライブラリ全体」ならライブラリ検索", () => {
  const pl = { viewMode: "playlist" as const, selectedPlaylistId: 7, searchQuery: "house" };
  assert.deepEqual(q({ ...pl, searchScope: "playlist" }), {
    kind: "playlist",
    playlistId: 7,
    smart: false,
    query: "house",
    sortField: "artist",
    sortOrder: "asc",
  });
  assert.deepEqual(q({ ...pl, searchScope: "library" }), {
    kind: "library",
    query: "house",
    sortField: "artist",
    sortOrder: "asc",
  });
  // 検索語が無ければスコープによらずプレイリスト。
  assert.equal(q({ ...pl, searchQuery: "", searchScope: "library" }).kind, "playlist");
  // ライブラリ検索に手動順は無い。
  assert.deepEqual(q({ ...pl, searchScope: "library", sortField: "playlistOrder" }), {
    kind: "library",
    query: "house",
    sortField: "name",
    sortOrder: "asc",
  });
});

test("プレイリスト未選択の playlist ビューはライブラリに倒す", () => {
  assert.equal(q({ viewMode: "playlist", selectedPlaylistId: null }).kind, "library");
});

test("trackListKey: 一覧が同じなら同じキー、どれか 1 つでも違えば違うキー", () => {
  const key = (over: Partial<TrackListState>) => trackListKey(q(over));
  assert.equal(key({}), key({}));
  const variants: Partial<TrackListState>[] = [
    {},
    { searchQuery: "a" },
    { filterTags: ["genre:House"] },
    { sortField: "name" },
    { sortOrder: "desc" },
    { viewMode: "playlist", selectedPlaylistId: 1, sortField: "playlistOrder" },
    { viewMode: "playlist", selectedPlaylistId: 1 },
    { viewMode: "playlist", selectedPlaylistId: 2 },
    { viewMode: "playlist", selectedPlaylistId: 2, playlistIsSmart: true },
    { viewMode: "playlist", selectedPlaylistId: 2, searchQuery: "a" },
    { viewMode: "inbox" },
    { viewMode: "recent" },
    { viewMode: "history" },
  ];
  const keys = variants.map(key);
  assert.equal(new Set(keys).size, keys.length);
  // 検索語と絞り込みタグは結合後の文字列が同じなら同じ一覧。
  assert.equal(key({ searchQuery: "a b" }), key({ searchQuery: "a", filterTags: ["b"] }));
});

test("albumScopeOf: 曲の一覧と同じ範囲。メモリ上の一覧と一覧なしは null (手元の曲を束ねる)", () => {
  assert.deepEqual(albumScopeOf(q({ searchQuery: "x" })), { query: "x", playlistId: null });
  assert.deepEqual(albumScopeOf(q({ viewMode: "playlist", selectedPlaylistId: 3 })), {
    query: "",
    playlistId: 3,
  });
  assert.equal(albumScopeOf(q({ viewMode: "recent" })), null);
  assert.equal(albumScopeOf(q({ viewMode: "inbox" })), null);
  assert.equal(albumScopeOf(q({ viewMode: "history" })), null);
});

test("trackListGroupKey: 並び順だけが違う一覧は同じ、スコープ・検索語が違えば違う", () => {
  const group = (over: Partial<TrackListState>) => trackListGroupKey(q(over));
  assert.equal(group({}), group({ sortField: "bpm", sortOrder: "desc" }));
  const pl = { viewMode: "playlist" as const, selectedPlaylistId: 1 };
  assert.equal(group({ ...pl, sortField: "playlistOrder" }), group({ ...pl, sortField: "name" }));
  const groups = [
    group({}),
    group({ searchQuery: "a" }),
    group(pl),
    group({ ...pl, selectedPlaylistId: 2 }),
    group({ ...pl, searchQuery: "a" }),
    group({ viewMode: "inbox" }),
    group({ viewMode: "recent" }),
  ];
  assert.equal(new Set(groups).size, groups.length);
});
