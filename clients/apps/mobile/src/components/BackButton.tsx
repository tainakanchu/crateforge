// 詳細画面（スタックの headerShown:false）用の戻るボタン。履歴が無ければホームへ。

import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { PALETTE } from "@/constants/brand";

export default function BackButton({ label = "戻る" }: { label?: string }) {
  const router = useRouter();
  const onPress = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="戻る"
        hitSlop={8}
        style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
      >
        <Ionicons name="chevron-back" size={22} color={PALETTE.accent} />
        <Text style={styles.text}>{label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 8, paddingTop: 4, flexDirection: "row" },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    paddingHorizontal: 8,
    gap: 2,
  },
  pressed: { opacity: 0.6 },
  text: { color: PALETTE.accent, fontSize: 16 },
});
