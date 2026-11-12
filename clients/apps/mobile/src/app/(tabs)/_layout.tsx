// タブナビ。ライブラリ・プレイリスト・リモート・設定の 4 タブ。
// ミニプレイヤー/再生エラー通知はルートレイアウト(_layout.tsx)へ移したのでここには置かない。

import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { BRAND, PALETTE } from "@/constants/brand";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: BRAND.accent,
        tabBarInactiveTintColor: PALETTE.textFaint,
        tabBarStyle: {
          backgroundColor: PALETTE.surface,
          borderTopColor: PALETTE.border,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "ライブラリ",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="library" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="playlists"
        options={{
          title: "プレイリスト",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="remote"
        options={{
          title: "リモート",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="game-controller" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "設定",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
