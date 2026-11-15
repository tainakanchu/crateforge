import { useEffect, useRef, useState } from "react";
import { KeyedCache } from "../lib/keyedCache";

/**
 * 展開行の遅延取得キャッシュ (AlbumsView / ArtistsView 共通)。中身は lib/keyedCache.ts。
 *
 * - `scope` (一覧のキー) が変わったら全部捨てる。同じキーでも一覧の範囲が違えば中身が違うため。
 *   切り替え前に始めた取得の結果は覚えない。
 * - `revision` (ライブラリの変更) が変わったら「取り直し待ち」にする。値は表示に使い続け、
 *   次に使うときに取り直す。
 *
 * 返すキャッシュは同じインスタンスのままなので、値の変化で再描画したい箇所は `epoch` を依存に入れる。
 */
export function useKeyedCache<V>(
  scope: string,
  revision: unknown,
): { cache: KeyedCache<V>; epoch: number } {
  const [epoch, setEpoch] = useState(0);
  const ref = useRef<KeyedCache<V> | null>(null);
  if (ref.current === null) ref.current = new KeyedCache<V>(() => setEpoch((e) => e + 1));
  const cache = ref.current;

  const scopeRef = useRef(scope);
  const revisionRef = useRef(revision);
  useEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      revisionRef.current = revision;
      cache.reset();
    } else if (!Object.is(revisionRef.current, revision)) {
      revisionRef.current = revision;
      cache.markAllStale();
    }
  }, [cache, scope, revision]);

  return { cache, epoch };
}
