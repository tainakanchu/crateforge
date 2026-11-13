// アプリのルート。プロバイダ群（gesture / safe-area / react-query）を張り、
// 起動時に接続復元・再生エンジン差し込み・音声初期化を行う。
// Gate が接続状態に応じて /connect と / を出し分ける。

import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppState, type AppStateStatus, Platform } from "react-native";
import { QueryClient, focusManager } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";

import { PALETTE } from "@/constants/brand";
import { createFilePersister } from "@/lib/queryPersister";
import { useConnection, useConnectionMonitor, usePlayer, useDownloads, useSettings } from "@crateforge/core";
import MiniPlayer from "@/components/MiniPlayer";
import { ActionSheetHost } from "@/components/ActionSheet";
import { ToastHost } from "@/components/Toast";
import DownloadFailureToast from "@/components/DownloadFailureToast";
import PlaybackErrorToast from "@/components/PlaybackErrorToast";
import ErrorBoundary from "@/components/ErrorBoundary";
import { usePendingEdits } from "@/store/pendingEdits";
import { flushPending } from "@/features/triage/syncPending";
import { onDownloadsHydrated, setupPlayback } from "@/playback/setupPlayback";

// stale でもキャッシュを即表示し、必要時のみ裏で更新する（stale-while-revalidate）。
// staleTime は 1 分: タブに戻る/アプリを前面に戻すと、1 分以上経った表示中の一覧だけ裏で取り直す
// （デスクトップ側の追加・編集が反映されないまま残らないように。round-2 M7）。
// 全曲取得（曲モード）は重いので useTracks 側で個別に長めの staleTime を指定している。
// すぐ反映したいときは各一覧のプル更新（RefreshControl）を使う。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      gcTime: 30 * 60 * 1000, // 30分メモリ保持
      retry: 1,
    },
  },
});

// アプリ再起動後も即座に前回キャッシュを表示するためのディスク永続化設定。
const persister = createFilePersister();

// 起動時に OTA を確認し、あれば取得して即リロード（次回起動を待たずその場で反映）。
// dev / 無効時は何もしない。best-effort なので失敗しても通常起動を続ける。
async function checkForOtaUpdate(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled) return;
  try {
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    }
  } catch {
    // ignore（次回起動でまた試みる）
  }
}

// React Query の「フォーカス」を AppState に繋ぐ（前面復帰で stale な表示中クエリを再取得）。
// web は既定の visibilitychange で動くので触らない。
function useAppStateFocus(): void {
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = AppState.addEventListener("change", (s: AppStateStatus) => {
      focusManager.setFocused(s === "active");
    });
    return () => sub.remove();
  }, []);
}

export default function RootLayout() {
  // 前面復帰・オフライン中の接続再確認・接続中の死活監視（core フック）。
  useConnectionMonitor();
  useAppStateFocus();
  useEffect(() => {
    // 再生バックエンドの差し込み（Android はネイティブ Media3、iOS 等は expo-audio）。hydrate より前に行う。
    setupPlayback();
    // 接続判定（Gate）の前にダウンロード/設定を読み込む。オフライン許可判定が DL の有無に依存するため。
    void (async () => {
      await Promise.all([
        // 読み込み後、ネイティブモードなら Android Auto のカタログへ取り込みを促す。
        useDownloads.getState().hydrate().then(onDownloadsHydrated),
        useSettings.getState().hydrate(),
        // shuffle / repeat の復元（再生ストア。ネイティブモードでは初回移行のみでキューは上書きしない）。
        usePlayer.getState().hydrate(),
        usePendingEdits.getState().hydrate(),
      ]);
      await useConnection.getState().hydrate();
    })();
    void checkForOtaUpdate();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister,
            maxAge: 24 * 60 * 60 * 1000, // 24時間でディスクキャッシュ破棄
            buster: "v1", // 破壊的変更時にここを変えてキャッシュを無効化
            dehydrateOptions: {
              // 永続化は「小さく・再起動時に即出したい」クエリだけに限定する。
              // 全曲リスト(["tracks",{limit}]) は数万件になり得て、丸ごと同期 file.write すると
              // メインスレッドが固まる（= アプリが激重になる原因）。これは永続化しない。
              // "artists" はサーバ集計の軽量リスト（Artist[] ≪ Track[]）なので永続化対象に含める。
              shouldDehydrateQuery: (q) => {
                if (q.state.status !== "success") return false;
                const key = q.queryKey[0];
                return key === "genres" || key === "playlists" || key === "albums" || key === "artists";
              },
            },
          }}
        >
          <StatusBar style="light" />
          <Gate />
          <PinnedPlaylistSync />
          <PendingEditsSync />
          {/* 描画エラーを捕捉したら再生を止める保険（主因の遷移クラッシュは別途修正済み）。 */}
          <ErrorBoundary>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: PALETTE.bg },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="connect" />
              <Stack.Screen name="player" options={{ presentation: "modal" }} />
            </Stack>
            {/* ミニプレイヤーは全画面で常時表示（出し分けは MiniPlayer 内でルート判定）。
                Stack の兄弟に置くことでスタック/タブどちらの画面にも重ねられる。 */}
            <MiniPlayer />
            {/* 再生エラーの通知（描画なし。アプリ内トーストを出す） */}
            <PlaybackErrorToast />
            <DownloadFailureToast />
            <ToastHost />
            <ActionSheetHost />
          </ErrorBoundary>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** 接続が利用可能になった時だけ、pin 済みプレイリストをサーバーの現在メンバーへ同期する。 */
function PinnedPlaylistSync() {
  const status = useConnection((s) => s.status);
  const client = useConnection((s) => s.client);

  useEffect(() => {
    if (status !== "connected" || !client) return;
    void useDownloads.getState().syncPinnedPlaylists((playlistId) =>
      client.playlistTracks(playlistId, { limit: 100000 }),
    );
  }, [status, client]);

  return null;
}

/** 接続確立時にオフライン中の評価/タグ編集をホストへ書き戻す (#125)。 */
function PendingEditsSync() {
  const status = useConnection((s) => s.status);
  const client = useConnection((s) => s.client);

  useEffect(() => {
    if (status !== "connected" || !client) return;
    void flushPending(client);
  }, [status, client]);

  return null;
}

/**
 * ルーティングのゲート（描画なし）。
 * - 復元完了前は何もしない（誤って /connect に飛ばさないため）。
 * - 接続済み / 接続情報あり（=以前接続した→オフライン許可）/ DL済みあり のいずれかなら入室可。
 * - 完全初回（接続情報もDLも無い）のときだけオンボーディングの /connect へ。
 */
function Gate() {
  const status = useConnection((s) => s.status);
  const hydrated = useConnection((s) => s.hydrated);
  const baseUrl = useConnection((s) => s.baseUrl);
  const hasDownloads = useDownloads((s) => Object.keys(s.entries).length > 0);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!hydrated) return;
    const onConnect = segments[0] === "connect";
    const canEnter =
      status === "connected" || status === "error" || baseUrl != null || hasDownloads;
    if (!canEnter && !onConnect) {
      router.replace("/connect");
    } else if (status === "connected" && onConnect) {
      router.replace("/");
    }
  }, [hydrated, status, baseUrl, hasDownloads, segments, router]);

  return null;
}
