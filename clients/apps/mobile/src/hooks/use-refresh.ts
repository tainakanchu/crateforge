// 一覧の更新手段（round-2 M7）。
// - usePullToRefresh: FlatList の RefreshControl 用。手動更新中だけ refreshing=true にする
//   （裏の自動再取得では引っ張りスピナーを出さない）。
// - useRefetchStaleOnFocus: 画面（タブ）に戻ったとき、表示中で古くなった（stale）クエリだけ再取得する。
// 前面復帰時の再取得は _layout で React Query の focusManager を AppState に繋いで行う。

import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

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

/**
 * 画面フォーカス時（初回マウントは除く）に、表示中（active）かつ stale なクエリを再取得する。
 * staleTime 内なら何もしないので、タブを行き来しても重い全件取得を連発しない。
 */
export function useRefetchStaleOnFocus(): void {
  const qc = useQueryClient();
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      void qc.refetchQueries({ type: "active", stale: true });
    }, [qc]),
  );
}
