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

const queryClient = new QueryClient();

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
