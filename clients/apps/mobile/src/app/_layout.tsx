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
import { useConnection, usePlayer, createAudioEngine, initPlayback } from "@crateforge/core";

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
    void useConnection.getState().hydrate();
    usePlayer.getState().setEngine(createAudioEngine());
    void initPlayback();
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
              // 成功クエリのみ永続化（loading/error は保存しない）
              shouldDehydrateQuery: (q) => q.state.status === "success",
            },
          }}
        >
          <StatusBar style="light" />
          <Gate />
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
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** 接続状態に応じて /connect ↔ / を出し分ける（描画なし）。 */
function Gate() {
  const status = useConnection((s) => s.status);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    const onConnect = segments[0] === "connect";
    if ((status === "idle" || status === "error") && !onConnect) {
      router.replace("/connect");
    } else if (status === "connected" && onConnect) {
      router.replace("/");
    }
  }, [status, segments, router]);

  return null;
}
