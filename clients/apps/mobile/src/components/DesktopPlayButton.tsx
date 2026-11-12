// 「デスクトップで再生」ボタン。接続中のみ表示し、曲リストを PC 側のキューに載せて再生する。

import { Pressable, StyleSheet, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type Track, useConnection } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import { playOnDesktop } from "@/features/playback/desktopPlay";

export default function DesktopPlayButton({ tracks }: { tracks: Track[] }) {
  const client = useConnection((s) => s.client);
  if (!client || tracks.length === 0) return null;
  return (
    <Pressable
      onPress={() => void playOnDesktop(tracks, 0)}
      accessibilityRole="button"
      accessibilityLabel="デスクトップで再生"
      style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
    >
      <Ionicons name="desktop-outline" size={18} color={PALETTE.accent} />
      <Text style={styles.text}>デスクトップで再生</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  pressed: { opacity: 0.7 },
  text: { color: PALETTE.accent, fontSize: 14, fontWeight: "600" },
});
