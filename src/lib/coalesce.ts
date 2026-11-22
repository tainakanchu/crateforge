/**
 * 短い間隔で続けて来る通知を、先頭 + 末尾の 2 回にまとめる。
 *
 * - 先頭: 直前の実行から `windowMs` 以上空いていれば、その場で実行する (単発は遅れない)。
 * - 末尾: 窓の中で来た通知は `merge` で 1 つにまとめ、窓が明けた時点で 1 回だけ実行する。
 *
 * `library-changed` が続けて届いたときに、一覧・プレイリストの取り直しを毎回走らせないために使う
 * (バックエンドでも同じ規則で間引いているが、API 以外から送られる分もあるので二段にしている)。
 */
export interface Coalescer<T> {
  /** 通知を 1 件渡す。 */
  push(value: T): void;
  /** 保留中の末尾の実行を取り消す (購読の解除時に呼ぶ)。 */
  cancel(): void;
}

export function createCoalescer<T>(
  fire: (value: T) => void,
  merge: (a: T, b: T) => T,
  windowMs: number,
): Coalescer<T> {
  let lastFire: number | null = null;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastFire = Date.now();
    fire(value);
  };

  return {
    push(value) {
      if (pending) {
        pending = { value: merge(pending.value, value) };
        return;
      }
      const now = Date.now();
      if (lastFire === null || now - lastFire >= windowMs) {
        lastFire = now;
        fire(value);
        return;
      }
      pending = { value };
      timer = setTimeout(flush, lastFire + windowMs - now);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}
