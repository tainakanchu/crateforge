// アルバム詳細への遷移先。
// アルバム一覧（/api/albums）は album 名単位で集計している（代表 albumArtist = MAX(album_artist)）ため、
// 詳細・保存も album 名の完全一致で揃える。albumArtist で絞るとコンピ/DJ ミックスで曲が欠ける（round-2 M1）。

export function albumHref(album: string): string {
  return `/album/${encodeURIComponent(album)}`;
}
