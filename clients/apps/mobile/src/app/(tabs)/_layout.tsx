// タブナビ。Library / Playlists / DJ / Remote / Settings の 5 タブ。
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
          title: "Library",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="library" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="playlists"
        options={{
          title: "Playlists",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list" size={size} color={color} />
          ),
        }}
      />
      {/* ファイル名は dj-home（フルスクリーンの /dj スタックルートと URL 衝突させないため）。 */}
      <Tabs.Screen
        name="dj-home"
        options={{
          title: "DJ",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="disc" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="remote"
        options={{
          title: "Remote",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="game-controller" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
