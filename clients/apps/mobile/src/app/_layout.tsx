// アプリのルート。プロバイダ群（gesture / safe-area / react-query）を張り、
// 起動時に接続復元・再生エンジン差し込み・音声初期化を行う。
// Gate が接続状態に応じて /connect と / を出し分ける。

import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";

import { PALETTE } from "@/constants/brand";
import { createFilePersister } from "@/lib/queryPersister";
import { useConnection, usePlayer, useDownloads, useSettings, createAudioEngine, initPlayback } from "@crateforge/core";
import MiniPlayer from "@/components/MiniPlayer";
import PlaybackErrorToast from "@/components/PlaybackErrorToast";
import ErrorBoundary from "@/components/ErrorBoundary";

// ライブラリは頻繁に変わらないので staleTime を長めに取り、タブ/モード切替のたびの
// 再取得を抑える。全曲取得（曲/アーティストモード）は重いので特に効く。
// stale でもキャッシュを即表示し、必要時のみ裏で更新する（stale-while-revalidate）。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5分は再取得しない
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

export default function RootLayout() {
  useEffect(() => {
    usePlayer.getState().setEngine(createAudioEngine());
    void initPlayback();
    // 接続判定（Gate）の前にダウンロード/設定を読み込む。オフライン許可判定が DL の有無に依存するため。
    void (async () => {
      await Promise.all([
        useDownloads.getState().hydrate(),
        useSettings.getState().hydrate(),
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
            {/* 再生エラーの通知（描画なし。Toast/Alert を出す） */}
            <PlaybackErrorToast />
          </ErrorBoundary>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
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
