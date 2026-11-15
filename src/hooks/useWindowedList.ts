import { useEffect, useMemo, useRef, useState } from "react";
import { WindowLoader } from "../lib/windowedList";

export interface WindowedListOptions<T> {
  /**
   * 一覧の同一性 (スコープ・検索語・並び順など)。変わったらキャッシュを捨てて取り直す
   * (呼び出し側は先頭へスクロールを戻す)。
   */
  key: string;
  /**
   * 取り直しの合図 (ライブラリの変更など)。変わったら表示中のページを取り直す。
   * 届くまでは古い内容を表示し続け、スクロール位置は保つ。
   */
  revision?: unknown;
  /** 全件数。未確定のあいだは 0 を渡す (何も取得しない)。 */
  count: number;
  /** offset から limit 件を取得する。 */
  fetchPage: (offset: number, limit: number) => Promise<T[]>;
  pageSize?: number;
  /** ページの取得に失敗したとき (key / revision ごとに 1 回)。 */
  onError?: (err: unknown) => void;
}

export interface WindowedList<T> {
  /** 全件数 (スクロール範囲はこの件数ぶん確保する)。 */
  count: number;
  /** 通し番号 index の項目。未取得なら undefined (プレースホルダを描く)。 */
  get: (index: number) => T | undefined;
  /** 表示中の項目の範囲 (通し番号。両端を含む) を伝える。足りないページの取得はここから始まる。 */
  setVisibleRange: (start: number, end: number) => void;
  /** index の項目を (未取得なら取得して) 返す。待つあいだに一覧が切り替わったら undefined。 */
  ensure: (index: number) => Promise<T | undefined>;
  /** 取得済みの項目を [通し番号, 項目] で列挙する。 */
  loaded: () => IterableIterator<[number, T]>;
  /** ページが届くたびに変わる値 (取得済みの内容に依存する useMemo の依存に使う)。 */
  version: number;
}

/**
 * 一覧のウィンドウ取得 (docs/library-list/design.md)。TrackTable / TracksView / AlbumsView /
 * ArtistsView が共用する。
 *
 * 件数ぶんのスクロール範囲は呼び出し側が確保し、この hook は「見えている範囲のページだけを
 * 取得してキャッシュする」ことを受け持つ。中身は lib/windowedList.ts の `WindowLoader`
 * (世代管理・重複排除・LRU キャッシュ・スクロール停止待ち) で、ここは React への配線だけ。
 */
export function useWindowedList<T>({
  key,
  revision,
  count,
  fetchPage,
  pageSize,
  onError,
}: WindowedListOptions<T>): WindowedList<T> {
  const [version, setVersion] = useState(0);

  const loaderRef = useRef<WindowLoader<T> | null>(null);
  if (loaderRef.current === null) {
    loaderRef.current = new WindowLoader<T>({
      fetchPage,
      onChange: () => setVersion((v) => v + 1),
      onError,
      pageSize,
    });
  }
  const loader = loaderRef.current;
  loader.setCallbacks({ fetchPage, onChange: () => setVersion((v) => v + 1), onError });

  // key / revision / count の変化はレンダー中に反映する (前の一覧の行を新しい key で 1 フレーム
  // 描かないため)。同じ値での再レンダーでは何も起きないので、二重レンダーでも結果は同じ。
  loader.sync({ key, revision, count });

  // key の切り替え・取り直し・件数の確定のあと、いまの表示範囲ぶんを取得する。
  useEffect(() => {
    loader.schedule();
  }, [loader, key, revision, count]);
  // アンマウント後に届く応答は捨てる (開発時の StrictMode の張り直しでは上の effect が取得し直す)。
  useEffect(() => () => loader.stop(), [loader]);

  // 関数は一覧が切り替わっても同じものを返す (effect の依存に入れても張り直しが起きない)。
  const api = useMemo(
    () => ({
      get: (index: number) => loader.get(index),
      setVisibleRange: (start: number, end: number) => loader.setVisibleRange(start, end),
      ensure: (index: number) => loader.ensure(index),
      loaded: () => loader.loaded(),
    }),
    [loader],
  );
  return useMemo(() => ({ ...api, count, version }), [api, count, version]);
}
