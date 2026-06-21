// Crateforge TV アプリのルートレイアウト。
// プロバイダ群（gesture / safe-area / react-query）を張り、
// 起動時に接続復元・再生エンジン差し込み・音声初期化を行う。
// Gate が接続状態に応じて /connect と / を出し分ける。

import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";

import { PALETTE } from "@/theme/palette";
import { useConnection, usePlayer, createAudioEngine, initPlayback } from "@crateforge/core";

// TV は軽量な QueryClient（永続化なし）で十分。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5分は再取得しない
      gcTime: 30 * 60 * 1000,   // 30分メモリ保持
      retry: 1,
    },
  },
});

// 起動時に OTA を確認し、あれば取得して即リロード（次回起動を待たず反映）。dev/無効時は何もしない。
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
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <Gate />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: PALETTE.bg },
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="connect" />
            <Stack.Screen name="player" />
            <Stack.Screen name="settings" />
          </Stack>
        </QueryClientProvider>
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
