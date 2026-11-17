// 曲の一覧のキーボード操作を、どのキーイベントで受けるかの判定 (純関数)。
// tests/desktop/listKeys.test.ts で固定。配線は hooks/useTrackListKeys.ts。

/** キーイベントが起きた状況 (DOM から読み取った結果)。 */
export interface ListKeyContext {
  /** イベントの対象要素 (フォーカスのある要素) のタグ名 (大文字)。 */
  targetTag: string | null;
  /** 対象が contentEditable か。 */
  targetEditable: boolean;
  /** モーダルが開いている。 */
  modalOpen: boolean;
}

/**
 * このキーイベントを曲の一覧の操作として扱ってよいか。どのキーも同じ規則:
 *
 * - モーダルが開いているときは扱わない。
 * - 入力欄・セレクト・編集中の要素にフォーカスがあるときは扱わない
 *   (文字入力・カーソル移動・選択肢の移動を奪わない)。
 * - それ以外 (フォーカスが無い、一覧の中、サイドバーやツールバーのボタンなど) では扱う。
 *
 * ↑ ↓ と PageUp / PageDown / Home / End で条件を変えない。ボタンにフォーカスが残っているだけで
 * 「↓ は効くのに PageDown は効かない」とならないようにするため。
 */
export function isListKeyEvent(ctx: ListKeyContext): boolean {
  if (ctx.modalOpen) return false;
  if (ctx.targetEditable) return false;
  return !(
    ctx.targetTag === "INPUT" ||
    ctx.targetTag === "TEXTAREA" ||
    ctx.targetTag === "SELECT"
  );
}
