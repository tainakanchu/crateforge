// アルバム詳細への遷移先。albumArtist があれば同名別アルバムを区別するため query に付ける。

export function albumHref(album: string, albumArtist?: string | null): string {
  const base = `/album/${encodeURIComponent(album)}`;
  return albumArtist ? `${base}?albumArtist=${encodeURIComponent(albumArtist)}` : base;
}
