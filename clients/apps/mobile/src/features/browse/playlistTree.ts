// プレイリストの親子階層を組み立てるヘルパ群。
// API は全プレイリストをフラットに返すので、persistentId / parentPersistentId で木を再構成する。
// フォルダは曲を持たない（trackCount 0）が子を含むため、trackCount で落としてはいけない。

import { type Playlist } from "@crateforge/core";

/** persistentId（無ければ playlistId 文字列）。親子の突き合わせキーとして使う。 */
function keyOf(p: Playlist): string {
  return p.persistentId ?? String(p.playlistId);
}

/** フォルダ優先 → 名前の昇順で並べる。 */
function sortItems(items: Playlist[]): Playlist[] {
  return [...items].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** parentPersistentId が parentPid に一致する子を、フォルダ優先・名前順で返す。 */
export function childrenOf(all: Playlist[], parentPid: string | null): Playlist[] {
  const matched = all.filter((p) => (p.parentPersistentId ?? null) === parentPid);
  return sortItems(matched);
}

/**
 * ルート（最上位）に置く項目。
 * parentPersistentId が null/空、または親 persistentId が一覧に存在しない（=孤児）ものを採用。
 */
export function rootItems(all: Playlist[]): Playlist[] {
  const present = new Set(all.map(keyOf));
  const roots = all.filter((p) => {
    const parent = p.parentPersistentId;
    if (parent == null || parent === "") return true;
    return !present.has(parent);
  });
  return sortItems(roots);
}
