// アルバム / アーティスト詳細への遷移先。
// アルバム一覧（/api/albums）は album 名単位で集計している（代表 albumArtist = MAX(album_artist)）ため、
// 詳細・保存も album 名の完全一致で揃える。albumArtist で絞るとコンピ/DJ ミックスで曲が欠ける（round-2 M1）。
//
// 不明なアルバム / アーティスト（タグに無い曲のグループ。API は空文字 "" で返す）:
// expo-router の動的セグメント [name] は空にできない（`/album/` は一覧ルートと衝突・クラッシュする）。
// そこでパスには UNKNOWN_SEGMENT を置き、`?unknown=1` を付けて「空名のグループ」を表す。
// 画面側は nameFromParams でこのフラグを見て空名として扱う（実在の "_" という名前とはフラグで区別）。

/** 不明なグループへ遷移するときのパスセグメント（値そのものに意味は無い）。 */
export const UNKNOWN_SEGMENT = "_";

/** 名前が空（null / "" / 空白のみ）か。 */
function isUnknownName(name: string | null | undefined): boolean {
  return !name || name.trim() === "";
}

export function albumHref(album: string | null | undefined): string {
  if (isUnknownName(album)) return `/album/${UNKNOWN_SEGMENT}?unknown=1`;
  return `/album/${encodeURIComponent(album!)}`;
}

export function artistHref(artist: string | null | undefined): string {
  if (isUnknownName(artist)) return `/artist/${UNKNOWN_SEGMENT}?unknown=1`;
  return `/artist/${encodeURIComponent(artist!)}`;
}

/**
 * 詳細画面のルートパラメータから名前を取り出す。`unknown=1` なら空文字（= 不明なグループ）、
 * それ以外は name をデコードした値（name が無ければ null）。
 */
export function nameFromParams(params: { name?: string; unknown?: string }): string | null {
  if (params.unknown === "1") return "";
  if (!params.name) return null;
  return decodeURIComponent(params.name);
}
