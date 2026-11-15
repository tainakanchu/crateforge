import { useEffect } from "react";
import type { DependencyList } from "react";
import { isTauri } from "../lib/env";
import { subscribeDisposable } from "../lib/tauriEvents";
import type { Unlisten } from "../lib/tauriEvents";

/**
 * Tauri イベントを購読し、アンマウント / deps の変化で解除する。
 *
 * `subscribe` は `api/*` の `onXxx(handler)` を呼んで `Promise<UnlistenFn>` を返す関数。
 * ハンドラが閉じ込める値は deps に並べる (useEffect と同じ規則)。
 * 購読の確立前に解除されても購読が残らない (`subscribeDisposable`)。
 * ブラウザ (vite dev) では何もしない。
 */
export function useTauriEvent(subscribe: () => Promise<Unlisten>, deps: DependencyList): void {
  useEffect(() => {
    if (!isTauri) return;
    return subscribeDisposable(subscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
