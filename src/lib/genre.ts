/**
 * ジャンル文字列 ⇔ タグ配列 (仕様: ジャンルは空白区切りのタグ集合)。
 * 分割は任意の空白に加え `;` `,` でも行う (v0.18–v0.19 が `"; "` で保存した文字列の互換)。
 * `/` は区切りではない ("R&B/Soul" は 1 タグ)。保存時は半角空白 1 つで連結する。
 * Rust 側 `db::tracks::split_genre_tags` と同じ規則にすること。
 */
export const GENRE_SEPARATORS = /[\s;,]+/;

/** タグを genre 文字列へ戻すときの区切り (Rust 側の GENRE_JOIN と同じ)。 */
export const GENRE_JOIN = " ";

export function splitGenre(genre: string | null | undefined): string[] {
  if (!genre) return [];
  return genre
    .split(GENRE_SEPARATORS)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function joinGenre(tags: string[]): string {
  return tags
    .flatMap((t) => splitGenre(t))
    .join(GENRE_JOIN);
}
