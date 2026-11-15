// デスクトップに届かない間だけコンテンツ上部に出す帯（TV 用）。
// 接続監視（core の useConnectionMonitor）が自動で再試行しているので、画面は /connect へ飛ばさず
// この帯で知らせる。IP が変わった等で戻らないときのために「接続し直す」で接続画面へ行ける。

import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import { selectIsOffline, useConnection } from "@crateforge/core";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

export function ConnectionBanner() {
  const router = useRouter();
  const offline = useConnection(selectIsOffline);

  if (!offline) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text} numberOfLines={2}>
        デスクトップに接続できません。自動で再接続を試しています…
      </Text>
      <Focusable
        onSelect={() => router.push("/connect")}
        style={styles.button}
        accessibilityLabel="接続し直す"
      >
        <Text style={styles.buttonText}>接続し直す</Text>
      </Focusable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    paddingHorizontal: TV_LAYOUT.contentPaddingH,
    paddingVertical: 12,
    backgroundColor: PALETTE.surface,
    borderBottomWidth: 1,
    borderBottomColor: PALETTE.border,
  },
  text: {
    flex: 1,
    color: PALETTE.text,
    fontSize: TV_FONT.xs,
  },
  button: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: FOCUS_RING.borderRadius,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
    backgroundColor: PALETTE.bg,
  },
  buttonText: {
    color: PALETTE.text,
    fontSize: TV_FONT.xs,
    fontWeight: "600",
  },
});
