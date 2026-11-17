import { useEffect, useMemo, useRef, useState } from "react";
import { WindowLoader } from "../lib/windowedList";
import { useListCount } from "./useListCount";

export interface WindowedListOptions<T> {
  /**
   * 一覧の同一性 (スコープ・検索語・並び順など)。変わったら先頭から取り直す
   * (呼び出し側は先頭へスクロールを戻す)。
   */
  key: string;
  /**
   * 並び順を除いた同一性 (スコープ・検索語)。件数はこれで決まるので、並び順だけを変えても
   * 件数を取り直さず、行数を保ったまま (空白にせず) 新しい並びへ入れ替わる。省略時は key。
   */
  group?: string;
  /**
   * 取り直しの合図 (ライブラリの変更など)。変わったら件数と表示中のページを取り直す。
   * 届くまでは古い内容を表示し続け、スクロール位置は保つ。
   */
  revision?: unknown;
  /**
   * 全件数。手元で分かる一覧 (メモリ上の配列) は数値、サーバの一覧は取得する関数を渡す
   * (group / revision が変わるたびに呼ぶ)。
   */
  count: number | (() => Promise<number>);
  /** offset から limit 件を取得する。 */
  fetchPage: (offset: number, limit: number) => Promise<T[]>;
  pageSize?: number;
  /** 件数・ページの取得に (再試行しても) 失敗したとき。 */
  onError?: (err: unknown) => void;
}

export interface WindowedList<T> {
  /** 一覧の同一性 (オプションの key そのまま)。 */
  key: string;
  /** 全件数 (スクロール範囲はこの件数ぶん確保する)。未確定のあいだは 0。 */
  count: number;
  /** 件数がまだ確定していない (一覧を開いた直後)。空の一覧とは区別する。 */
  loading: boolean;
  /** 通し番号 index の項目。未取得なら undefined (プレースホルダを描く)。 */
  get: (index: number) => T | undefined;
  /** 表示中の項目の範囲 (通し番号。両端を含む) を伝える。足りないページの取得はここから始まる。 */
  setVisibleRange: (start: number, end: number) => void;
  /** index の項目を (未取得なら取得して) 返す。待つあいだに一覧が切り替わったら undefined。 */
  ensure: (index: number) => Promise<T | undefined>;
  /** 取得済みの項目を [通し番号, 項目] で列挙する。 */
  loaded: () => IterableIterator<[number, T]>;
  /**
   * 取得済みの行を並べ替える (先行表示)。itemAt は新しい並びでの通し番号 → 項目。
   * 埋められないページは取り直す。
   */
  remap: (itemAt: (index: number) => T | undefined) => void;
  /** ページが届くたびに変わる値 (取得済みの内容に依存する useMemo の依存に使う)。 */
  version: number;
  /** 表示中の範囲に、再試行しても取得できなかったページがある (再試行の案内を出す)。 */
  failed: boolean;
  /** 取得できなかったページを取り直す。 */
  retry: () => void;
}

/**
 * 一覧のウィンドウ取得 (docs/library-list/design.md)。TrackTable / TracksView / AlbumsView /
 * ArtistsView が共用する唯一の入口で、「一覧のキー・件数・見えている範囲のページ」をまとめて持つ。
 *
 * 呼び出し側は件数ぶんのスクロール範囲を確保し、見えている範囲を `setVisibleRange` で伝える。
 * 中身は lib/windowedList.ts の `WindowLoader` (世代管理・重複排除・LRU キャッシュ・
 * スクロール停止待ち・失敗の再試行) と `useListCount` (件数) で、ここは React への配線だけ。
 */
export function useWindowedList<T>({
  key,
  group = key,
  revision,
  count: countSource,
  fetchPage,
  pageSize,
  onError,
}: WindowedListOptions<T>): WindowedList<T> {
  const [version, setVersion] = useState(0);

  const fetchedCount = useListCount(
    group,
    revision,
    typeof countSource === "function" ? countSource : null,
    onError,
  );
  const known = typeof countSource === "number" ? countSource : fetchedCount;
  const count = known ?? 0;

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
  // 描かないため。effect に回すと、切り替えた直後のレンダーが前の一覧のキャッシュを読む)。
  //
  // レンダー中に呼んでよいのは、sync が「同じ引数なら何度呼んでも同じ状態」だから:
  // 値が前回と同じなら何もせず、取得 (副作用) は始めない。React が同じレンダーを 2 回走らせても
  // (StrictMode・中断と再開)、2 回目は no-op になる。sync に取得やコールバック呼び出しを足しては
  // いけない (それらは下の effect の schedule で行う)。
  loader.sync({ key, group, revision, count });

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
      remap: (itemAt: (index: number) => T | undefined) => loader.remap(itemAt),
      retry: () => loader.retryFailed(),
    }),
    [loader],
  );
  const failed = loader.hasFailedVisible();
  const loading = known === null;
  return useMemo(
    () => ({ ...api, key, count, loading, version, failed }),
    [api, key, count, loading, version, failed],
  );
}
