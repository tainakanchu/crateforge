// 「選択中の曲そのもの」を読み込む操作の上限。
//
// 一覧は見えている範囲の曲しか持たず、全選択は数万曲になりうる。レーティング・キュー・
// プレイリスト追加・削除などは trackId だけで済むので何曲でも扱えるが、曲の情報そのものが要る操作
// (Get Info の一括編集・Crate への追加) は全曲を読み込むことになる。ライブラリ全体をメモリに
// 載せない (docs/ui-spec.md 1.4) ため、この曲数を超える選択では行わず、理由を知らせる。

/** 曲の情報を読み込んで行う操作に渡せる曲数の上限。 */
export const SELECTION_TRACKS_MAX = 1000;

/** 上限を超えているときに出す文言 (超えていなければ null)。action は「編集」「Crate に追加」など。 */
export function selectionTooLargeMessage(count: number, action: string): string | null {
  if (count <= SELECTION_TRACKS_MAX) return null;
  return `${count.toLocaleString()} 曲は一度に${action}できません（${SELECTION_TRACKS_MAX.toLocaleString()} 曲まで）。選択を減らしてください`;
}
