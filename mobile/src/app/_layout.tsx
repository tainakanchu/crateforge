// アプリのルート。プロバイダ群（gesture / safe-area / react-query）を張り、
// 起動時に接続復元・再生エンジン差し込み・音声初期化を行う。
// Gate が接続状態に応じて /connect と / を出し分ける。

import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { PALETTE } from "@/constants/brand";
import { useConnection } from "@/store/connection";
import { usePlayer } from "@/store/player";
import { createAudioEngine, initPlayback } from "@/features/playback/engine";

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

export default function RootLayout() {
  useEffect(() => {
    void useConnection.getState().hydrate();
    usePlayer.getState().setEngine(createAudioEngine());
    void initPlayback();
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
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="connect" />
            <Stack.Screen name="player" options={{ presentation: "modal" }} />
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
