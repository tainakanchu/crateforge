/**
 * catch した値から表示用のメッセージを取り出す。
 *
 * Tauri コマンドの失敗は `Error` ではなく `{ code, message }` のような素のオブジェクトで
 * 届くことがある。`String(e)` だと "[object Object]" になるので message を優先する。
 */
export function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}
