// タブナビ。Library / Playlists / Remote / Settings の 4 タブ。
// ミニプレイヤーはタブバーの上に重ねて常時表示する（兄弟として配置）。

import { View } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { BRAND, PALETTE } from "@/constants/brand";
import MiniPlayer from "@/components/MiniPlayer";
import PlaybackErrorToast from "@/components/PlaybackErrorToast";

export default function TabsLayout() {
  return (
    <View style={{ flex: 1 }}>
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
      <MiniPlayer />
      {/* 再生エラーの通知（描画なし。Toast/Alert を出す） */}
      <PlaybackErrorToast />
    </View>
  );
}
