// アイコン 1 個の押下ボタン。Ionicons をタップ領域つきで包む。

import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { PALETTE } from "@/constants/brand";

export interface IconButtonProps {
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  size?: number;
  color?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export default function IconButton({
  name,
  onPress,
  size = 24,
  color = PALETTE.text,
  disabled = false,
  accessibilityLabel,
}: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && !disabled && styles.pressed]}
    >
      <Ionicons name={name} size={size} color={disabled ? PALETTE.textFaint : color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
  },
  pressed: {
    opacity: 0.6,
  },
});
