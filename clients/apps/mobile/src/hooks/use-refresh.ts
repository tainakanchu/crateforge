// 一覧の更新手段（round-2 M7）。
// - usePullToRefresh: FlatList の RefreshControl 用。手動更新中だけ refreshing=true にする
//   （裏の自動再取得では引っ張りスピナーを出さない）。
// - useRefetchStaleOnFocus: 画面（タブ）に戻ったとき、その画面のクエリのうち古くなったものだけ再取得する。
// 前面復帰時の再取得は _layout で React Query の focusManager を AppState に繋いで行う。

import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";

export function usePullToRefresh(refetch: () => Promise<unknown>): {
  refreshing: boolean;
  onRefresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        await refetch();
      } catch {
        // 失敗は各クエリのエラー表示に任せる。
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refetch]);
  return { refreshing, onRefresh };
}

/** フォーカス時に再取得する対象。queryKey は前方一致。 */
export interface FocusRefetchTarget {
  queryKey: QueryKey;
  /**
   * 指定時: 最終取得からこの時間（ms）以上経っていれば再取得する（軽い一覧向けに短い鮮度閾値を使う）。
   * 未指定: 通常どおり stale（staleTime 超過）なものだけ再取得する（全曲一覧など重いもの）。
   */
  freshMs?: number;
}

/** 軽い一覧（プレイリスト/アルバム/アーティスト）のフォーカス時の鮮度閾値（round-3 N5）。 */
export const LIGHT_LIST_FRESH_MS = 10 * 1000;

/**
 * 画面フォーカス時（初回マウントは除く）に、この画面のクエリ（targets）だけを再取得する。
 * タブは裏でもマウントされたまま（＝他タブのクエリも active）なので、キーで絞らないと
 * 他タブの一覧まで取り直してしまう（round-3 N5）。表示中（active）のクエリだけが対象。
 */
export function useRefetchStaleOnFocus(targets: readonly FocusRefetchTarget[]): void {
  const qc = useQueryClient();
  const first = useRef(true);
  // targets は毎レンダー新しい配列でもよい（フォーカス時に最新を読む）。
  // フォーカス処理より先に宣言した effect で更新する（描画中に ref を書き換えない）。
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
  });
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      for (const { queryKey, freshMs } of targetsRef.current) {
        if (freshMs != null) {
          const threshold = Date.now() - freshMs;
          void qc.refetchQueries({
            queryKey,
            type: "active",
            predicate: (q) => q.state.dataUpdatedAt <= threshold,
          });
        } else {
          void qc.refetchQueries({ queryKey, type: "active", stale: true });
        }
      }
    }, [qc]),
  );
}
