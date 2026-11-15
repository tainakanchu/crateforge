/** 購読の解除関数 (`@tauri-apps/api/event` の `UnlistenFn` と同じ形)。 */
export type Unlisten = () => void;

/**
 * 非同期に確立する購読 (`listen()` が返す `Promise<UnlistenFn>`) を、同期の解除関数にする。
 *
 * `let unlisten; (async () => { unlisten = await listen(...) })(); return () => unlisten?.()`
 * の形だと、購読が確立する前に解除 (effect の cleanup) が走ったとき unlisten がまだ無く、
 * 後から確立した購読が解除されずに残る (StrictMode の二重マウントや依存の変化で起きる)。
 * ここでは解除済みなら確立した時点で解除する。
 */
export function subscribeDisposable(subscription: Promise<Unlisten>): () => void {
  let disposed = false;
  let unlisten: Unlisten | undefined;
  subscription.then(
    (u) => {
      if (disposed) u();
      else unlisten = u;
    },
    (err) => {
      console.error("Failed to subscribe:", err);
    },
  );
  return () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}
