import { useEffect, useRef, useState } from "react";

/**
 * 一覧の全件数を取る (docs/library-list/design.md §1: スクロール範囲を最初から全件ぶん確保する)。
 *
 * - `key` が変わったら件数は未確定 (null) に戻り、取得できたら確定する。
 * - `revision` が変わったら取り直すが、届くまでは前の件数を返す (行数を一度 0 に戻さない)。
 * - 古い取得の応答は捨てる。失敗したら `onError` に渡し、件数は 0 として確定する。
 *
 * `fetchCount` が null のとき (件数が手元で分かる一覧) は何もせず null を返す。
 */
export function useListCount(
  key: string,
  revision: unknown,
  fetchCount: (() => Promise<number>) | null,
  onError?: (err: unknown) => void,
): number | null {
  const [state, setState] = useState<{ key: string; count: number } | null>(null);
  const fetchRef = useRef(fetchCount);
  fetchRef.current = fetchCount;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const enabled = fetchCount !== null;

  useEffect(() => {
    const fetch = fetchRef.current;
    if (!fetch) return;
    let alive = true;
    fetch().then(
      (count) => {
        if (alive) setState({ key, count });
      },
      (err) => {
        if (!alive) return;
        setState({ key, count: 0 });
        onErrorRef.current?.(err);
      },
    );
    return () => {
      alive = false;
    };
  }, [key, revision, enabled]);

  return enabled && state !== null && state.key === key ? state.count : null;
}
