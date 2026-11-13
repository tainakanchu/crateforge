// タグにアーティスト / アルバムが無い曲の表示ラベル。
// 取り込み時にフォルダ名などで埋めず空のまま保存するので、名前を主テキストとして出す場所
// (Artists / Albums のグループ、展開見出しなど) ではこのラベルに置き換える。
// 一覧の列 (TrackTable) は空セルのままでよい。

export const UNKNOWN_ARTIST_LABEL = "不明なアーティスト";
export const UNKNOWN_ALBUM_LABEL = "不明なアルバム";

/** アーティスト名 (空 / 空白のみ / null は「不明なアーティスト」)。 */
export function artistLabel(name: string | null | undefined): string {
  return name?.trim() ? name : UNKNOWN_ARTIST_LABEL;
}

/** アルバム名 (空 / 空白のみ / null は「不明なアルバム」)。 */
export function albumLabel(name: string | null | undefined): string {
  return name?.trim() ? name : UNKNOWN_ALBUM_LABEL;
}
