// モーダル内のフォーカストラップ (Tab の循環) の判定。DOM に依存しない純関数。

/** Tab で止まれる要素のセレクタ。 */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** フォーカスできる要素が 1 つも無いとき: ダイアログ本体へフォーカスを置く。 */
export const TRAP_CONTAINER = "container" as const;

/**
 * Tab / Shift+Tab が押されたときにフォーカスを移す先を返す。
 *
 * - 末尾で Tab → 先頭、先頭で Shift+Tab → 末尾 (循環)
 * - フォーカスできる要素が無い → `TRAP_CONTAINER`
 * - それ以外 → null (ブラウザ既定の移動に任せる)
 */
export function nextTrapFocus<T>(
  focusable: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | typeof TRAP_CONTAINER | null {
  if (focusable.length === 0) return TRAP_CONTAINER;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}
