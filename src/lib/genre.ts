/**
 * ジャンル文字列 ⇔ タグ配列。区切りは明示区切り (`;` `,` `/`) のみで、空白では割らない
 * ("Deep House" は 1 タグ)。Rust 側 `db::tracks::split_genre_tags` と同じ規則にすること。
 */
export const GENRE_SEPARATORS = /[;,/]/;

/** タグを genre 文字列へ戻すときの区切り (Rust 側の GENRE_JOIN と同じ)。 */
export const GENRE_JOIN = "; ";

export function splitGenre(genre: string | null | undefined): string[] {
  if (!genre) return [];
  return genre
    .split(GENRE_SEPARATORS)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function joinGenre(tags: string[]): string {
  return tags
    .map((t) => t.trim())
    .filter(Boolean)
    .join(GENRE_JOIN);
}
