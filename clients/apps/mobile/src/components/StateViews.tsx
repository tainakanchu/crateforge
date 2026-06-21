// 取得状態の表示（読み込み中 / エラー / 空）。各画面で使い回す。

import { ActivityIndicator, Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { BRAND, PALETTE } from "@/constants/brand";

/** 読み込み中（中央にアクセント色スピナー）。 */
export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={PALETTE.accent} size="large" />
    </View>
  );
}

export interface ErrorViewProps {
  message: string;
  onRetry?: () => void;
}

/** エラー表示（任意で再試行ボタン）。 */
export function ErrorView({ message, onRetry }: ErrorViewProps) {
  return (
    <View style={styles.center}>
      <Ionicons name="alert-circle-outline" size={40} color={PALETTE.danger} />
      <Text style={styles.message}>{message}</Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
        >
          <Text style={styles.retryText}>再試行</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface EmptyViewProps {
  message: string;
  icon?: keyof typeof Ionicons.glyphMap;
}

/** 空表示。 */
export function EmptyView({ message, icon = "file-tray-outline" }: EmptyViewProps) {
  return (
    <View style={styles.center}>
      <Ionicons name={icon} size={40} color={PALETTE.textFaint} />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  message: {
    color: PALETTE.textDim,
    fontSize: 15,
    textAlign: "center",
  },
  retry: {
    marginTop: 4,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: PALETTE.accent,
  },
  retryPressed: {
    opacity: 0.7,
  },
  retryText: {
    color: BRAND.accentText,
    fontWeight: "700",
    fontSize: 14,
  },
});
