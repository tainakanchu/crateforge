// 中央ペインが「どの曲の一覧を見ているか」を、ストアの状態から 1 つの値に決める純関数。
// React / Tauri に依存しない (tests/desktop/trackListQuery.test.ts で固定)。
// 取得は api/trackList.ts が TrackListQuery を各コマンドへ振り分ける。
import type { SearchScope, SortField, SortOrder, ViewMode } from "../types";
import { combineQuery } from "./query.ts";

export type TrackListQuery =
  /** 曲の一覧を持たないビュー (Set History)。 */
  | { kind: "none" }
  /**
   * 件数に上限のあるメモリ上の一覧 (Inbox / 最近再生した曲)。App が組み立ててストアの
   * `tracks` に置く。検索語・並び順は効かない。
   */
  | { kind: "memory"; source: "inbox" | "recent" }
  /** ライブラリ全体。query が空なら全曲、あれば検索結果。 */
  | { kind: "library"; query: string; sortField: SortField; sortOrder: SortOrder }
  /**
   * プレイリストの曲 (query があればプレイリスト内検索)。sortField が無いのは手動順
   * (通常プレイリストの sort_index 順)。
   */
  | {
      kind: "playlist";
      playlistId: number;
      smart: boolean;
      query: string;
      sortField?: SortField;
      sortOrder?: SortOrder;
    };

export interface TrackListState {
  viewMode: ViewMode;
  selectedPlaylistId: number | null;
  /** 選択中のプレイリストがスマートプレイリストか (一覧が未ロードなら false)。 */
  playlistIsSmart: boolean;
  searchQuery: string;
  searchScope: SearchScope;
  filterTags: readonly string[];
  sortField: SortField;
  sortOrder: SortOrder;
}

/**
 * 表示中の一覧を決める。
 *
 * - Set History は一覧なし、Inbox / 最近再生した曲はメモリ上の一覧。
 * - プレイリスト表示中は、検索語が無いか検索スコープが「このプレイリスト」ならプレイリストの中。
 *   スコープが「ライブラリ全体」で検索語があるときだけライブラリ検索になる。
 * - それ以外はライブラリ (検索語 + 絞り込みタグを空白区切りの AND で結合)。
 * - `"playlistOrder"` はプレイリストの手動順を指す疑似ソート。通常プレイリストでは sortField を
 *   渡さないことで表す。手動順を持たない一覧 (ライブラリ / 検索 / スマート) では曲名の昇順に倒す。
 */
export function resolveTrackListQuery(s: TrackListState): TrackListQuery {
  if (s.viewMode === "history") return { kind: "none" };
  if (s.viewMode === "inbox") return { kind: "memory", source: "inbox" };
  if (s.viewMode === "recent") return { kind: "memory", source: "recent" };

  const query = combineQuery(s.searchQuery, s.filterTags);
  const manualOrder = s.sortField === "playlistOrder";
  const sortField: SortField = manualOrder ? "name" : s.sortField;
  const sortOrder: SortOrder = manualOrder ? "asc" : s.sortOrder;

  if (
    s.viewMode === "playlist" &&
    s.selectedPlaylistId !== null &&
    (!query || s.searchScope === "playlist")
  ) {
    const base = { kind: "playlist" as const, playlistId: s.selectedPlaylistId, query };
    if (s.playlistIsSmart) return { ...base, smart: true, sortField, sortOrder };
    return manualOrder ? { ...base, smart: false } : { ...base, smart: false, sortField, sortOrder };
  }
  return { kind: "library", query, sortField, sortOrder };
}

/** 一覧の同一性を表すキー。変わったらキャッシュを捨てて先頭から取り直す。 */
export function trackListKey(q: TrackListQuery): string {
  switch (q.kind) {
    case "none":
      return "none";
    case "memory":
      return `memory:${q.source}`;
    case "library":
      return JSON.stringify(["library", q.query, q.sortField, q.sortOrder]);
    case "playlist":
      return JSON.stringify([
        "playlist",
        q.playlistId,
        q.smart,
        q.query,
        q.sortField ?? null,
        q.sortOrder ?? null,
      ]);
  }
}

/**
 * 並び順を除いた同一性 (スコープ + 検索語)。件数と「どの曲が入っているか」はこれで決まる。
 * 並び順だけを変えたときは変わらないので、件数や選択を保てる。
 */
export function trackListGroupKey(q: TrackListQuery): string {
  switch (q.kind) {
    case "none":
    case "memory":
      return trackListKey(q);
    case "library":
      return JSON.stringify(["library", q.query]);
    case "playlist":
      return JSON.stringify(["playlist", q.playlistId, q.smart, q.query]);
  }
}

/** アルバム表示の対象範囲 (サーバ集約に渡す検索語とプレイリスト)。 */
export interface AlbumScope {
  query: string;
  playlistId: number | null;
}

/**
 * 曲の一覧と同じ範囲をアルバム表示用に取り出す。メモリ上の一覧 (Inbox / 最近) と一覧なしは
 * null (サーバ集約を使わず、手元の曲を束ねる)。
 */
export function albumScopeOf(q: TrackListQuery): AlbumScope | null {
  if (q.kind === "library") return { query: q.query, playlistId: null };
  if (q.kind === "playlist") return { query: q.query, playlistId: q.playlistId };
  return null;
}
