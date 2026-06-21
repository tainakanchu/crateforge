// Crateforge TV 設定画面。
// 現在の接続情報を表示し、切断できる。

import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { useConnection } from "@crateforge/core";
import { PALETTE, TV_FONT } from "@/theme/palette";

export default function SettingsScreen() {
  const router = useRouter();
  const baseUrl = useConnection((s) => s.baseUrl);
  const disconnect = useConnection((s) => s.disconnect);
  const [focusedBtn, setFocusedBtn] = useState<string | null>(null);

  const handleDisconnect = async () => {
    await disconnect();
    // Gate が /connect へリダイレクトする
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>設定</Text>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>接続先</Text>
          <Text style={styles.cardValue}>{baseUrl ?? "未接続"}</Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            style={[
              styles.button,
              styles.dangerButton,
              focusedBtn === "disconnect" && styles.buttonFocused,
            ]}
            onFocus={() => setFocusedBtn("disconnect")}
            onBlur={() => setFocusedBtn(null)}
            onPress={handleDisconnect}
            hasTVPreferredFocus
          >
            <Text style={styles.buttonText}>切断</Text>
          </Pressable>

          <Pressable
            style={[
              styles.button,
              focusedBtn === "back" && styles.buttonFocused,
            ]}
            onFocus={() => setFocusedBtn("back")}
            onBlur={() => setFocusedBtn(null)}
            onPress={() => router.back()}
          >
            <Text style={styles.buttonText}>← 戻る</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
  container: {
    flex: 1,
    padding: 64,
    gap: 32,
  },
  title: {
    fontSize: TV_FONT.xl,
    fontWeight: "700",
    color: PALETTE.teal,
    marginBottom: 16,
  },
  card: {
    backgroundColor: PALETTE.surface,
    padding: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 8,
  },
  cardLabel: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
  },
  cardValue: {
    fontSize: TV_FONT.md,
    color: PALETTE.text,
    fontFamily: "monospace",
  },
  actions: {
    flexDirection: "row",
    gap: 24,
    marginTop: 16,
  },
  button: {
    backgroundColor: PALETTE.surface,
    paddingVertical: 20,
    paddingHorizontal: 48,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: "transparent",
  },
  dangerButton: {
    backgroundColor: "#5C1A1A",
  },
  buttonFocused: {
    borderColor: PALETTE.teal,
  },
  buttonText: {
    fontSize: TV_FONT.md,
    color: PALETTE.text,
    fontWeight: "600",
  },
});
