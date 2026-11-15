// 曲の一覧のキーボード操作を、どのキーイベントで受けるかの判定 (純関数)。
// tests/desktop/listKeys.test.ts で固定。配線は hooks/useTrackListKeys.ts。

/** キーイベントが起きた状況 (DOM から読み取った結果)。 */
export interface ListKeyContext {
  /** イベントの対象要素のタグ名 (大文字)。 */
  targetTag: string | null;
  /** 対象が contentEditable か。 */
  targetEditable: boolean;
  /** モーダルが開いている。 */
  modalOpen: boolean;
  /** フォーカスがどこにも無い (document.body) か、一覧の中にある。 */
  focusOnListOrNowhere: boolean;
  /** ポインタが一覧の上にある。 */
  pointerOverList: boolean;
}

/** 一覧のスクロール位置を大きく動かすキー (ブラウザ標準ではスクロールに使う)。 */
function isPagingKey(key: string): boolean {
  return key === "PageUp" || key === "PageDown" || key === "Home" || key === "End";
}

/**
 * このキーイベントを曲の一覧の操作として扱ってよいか。
 *
 * - モーダルが開いているとき、入力欄・セレクト・編集中の要素にフォーカスがあるときは扱わない
 *   (文字入力や選択肢の移動を奪わない)。
 * - PageUp / PageDown / Home / End は、ほかの場所ではその場所のスクロールに使うキーなので、
 *   「フォーカスがどこにも無いか一覧の中にある」か「ポインタが一覧の上にある」ときだけ扱う
 *   (サイドバーや右ペインを操作しているときのスクロールを奪わない)。
 * - それ以外のキー (↑ ↓ / Ctrl+A / Enter / Delete など) は従来どおり、上の除外に当たらなければ扱う。
 */
export function isListKeyEvent(key: string, ctx: ListKeyContext): boolean {
  if (ctx.modalOpen) return false;
  if (ctx.targetEditable) return false;
  if (ctx.targetTag === "INPUT" || ctx.targetTag === "TEXTAREA" || ctx.targetTag === "SELECT") {
    return false;
  }
  if (isPagingKey(key)) return ctx.focusOnListOrNowhere || ctx.pointerOverList;
  return true;
}
