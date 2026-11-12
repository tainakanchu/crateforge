// アルバム単位の曲の絞り込み（アルバム詳細・アルバム保存で共有）。
// `GET /api/tracks?album=` は部分一致なので、"Dawn" が "Dawn (Remixes)" も拾ってしまう。
// ここで album 名の完全一致（+ 任意で albumArtist）に絞る。

import type { Track } from "./types";

/** 比較用の正規化（前後空白のみ除去。大文字小文字・記号は区別する = DB の GROUP BY album と同じ粒度）。 */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim();
}

/**
 * album 名が完全一致する曲だけを返す（入力順を保持）。
 * - albumArtist を渡したとき: album_artist が設定されていて別の値の曲（同名の別アーティストのアルバム）を除く。
 *   album_artist 未設定の曲は残す（タグが不揃いなアルバムで曲が欠けないように）。
 * - albumArtist が null/undefined/空なら album 名だけで絞る。
 */
export function filterAlbumTracks(
  tracks: Track[],
  album: string,
  albumArtist?: string | null,
): Track[] {
  const wantAlbum = norm(album);
  const wantArtist = norm(albumArtist);
  return tracks.filter((t) => {
    if (norm(t.album) !== wantAlbum) return false;
    if (wantArtist === "") return true;
    const aa = norm(t.albumArtist);
    return aa === "" || aa === wantArtist;
  });
}
