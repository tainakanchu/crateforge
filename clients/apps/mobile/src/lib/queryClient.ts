// アプリ全体で 1 つの React Query クライアント。
// ルートの Provider（app/_layout.tsx）に渡すほか、フック外（長押しメニューなど）から
// 一覧を無効化するときにも同じインスタンスを使う。

import { QueryClient } from "@tanstack/react-query";

// stale でもキャッシュを即表示し、必要時のみ裏で更新する（stale-while-revalidate）。
// staleTime は 1 分: タブに戻る/アプリを前面に戻すと、1 分以上経った表示中の一覧だけ裏で取り直す
// （デスクトップ側の追加・編集が反映されないまま残らないように。round-2 M7）。
// 全曲取得（曲モード）は重いので useTracks 側で個別に長めの staleTime を指定している。
// すぐ反映したいときは各一覧のプル更新（RefreshControl）を使う。
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      gcTime: 30 * 60 * 1000, // 30分メモリ保持
      retry: 1,
    },
  },
});
