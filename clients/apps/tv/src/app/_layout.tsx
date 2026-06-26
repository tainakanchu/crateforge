// Crateforge TV アプリのルートレイアウト。
// プロバイダ群（gesture / safe-area / react-query）を張り、
// 起動時に接続復元・再生エンジン差し込み・音声初期化を行う。
//
// シェル構造:
//   - 未接続時: /connect 画面を全画面で表示（Gate が自動リダイレクト）。
//   - 接続済み時: 「左サイドナビ ＋ 右コンテンツ(Slot)」の 2 カラム 10ft UI。
//
// Gate コンポーネントが接続状態に応じて /connect と / を出し分ける（描画なし）。

import { useEffect } from "react";
import { View, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Slot, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";

import { PALETTE } from "@/theme/palette";
import { useConnection, createAudioEngine, initPlayback } from "@crateforge/core";
import { usePlayer } from "@/stores/playerStore";
import { SideNav } from "@/components/shell/SideNav";

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
    // 接続情報を SecureStore から復元する。
    void useConnection.getState().hydrate();
    // expo-audio エンジンを差し込む（TV でもロック画面コントロールが使えるよう同じ実装を利用）。
    usePlayer.getState().setEngine(createAudioEngine());
    // バックグラウンド再生・ロック画面コントロールを有効化する。
    void initPlayback();
    // OTA 更新チェック。
    void checkForOtaUpdate();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          {/* Gate: 接続状態に応じて /connect ↔ / をリダイレクト（描画なし）。 */}
          <Gate />
          {/* AppShell: 接続済みは 2 カラムシェル、未接続は全画面。 */}
          <AppShell />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * 接続状態に応じて /connect ↔ / を出し分ける（描画なし）。
 * expo-router の useSegments / useRouter を使うため、Provider 内でのみ動作する。
 */
function Gate() {
  const status = useConnection((s) => s.status);
  const hydrated = useConnection((s) => s.hydrated);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // hydrate() が完了するまでリダイレクト判定をしない（接続情報復元を待つ）。
    if (!hydrated) return;
    const onConnect = segments[0] === "connect";
    if ((status === "idle" || status === "error") && !onConnect) {
      router.replace("/connect");
    } else if (status === "connected" && onConnect) {
      router.replace("/");
    }
  }, [status, hydrated, segments, router]);

  return null;
}

/**
 * アプリシェル。
 * - /connect 画面: 全画面（サイドナビなし）。
 * - それ以外の画面: 左サイドナビ + 右コンテンツ（Slot）。
 */
function AppShell() {
  const segments = useSegments();
  // connect 画面（ペアリング中）はサイドナビを非表示にして全画面で表示する。
  const isConnectScreen = segments[0] === "connect";

  if (isConnectScreen) {
    return (
      <View style={styles.fullscreen}>
        <Slot />
      </View>
    );
  }

  return (
    <View style={styles.shell}>
      {/* 左: 縦型サイドナビ（常時表示） */}
      <SideNav />
      {/* 右: 現在ルートのコンテンツ */}
      <View style={styles.content}>
        <Slot />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreen: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
  shell: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: PALETTE.bg,
  },
  content: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
});
