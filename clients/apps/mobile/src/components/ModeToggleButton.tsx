// シャッフル/リピートのオン・オフ切替ボタン（プレイヤー・リモート共通）。
// オン時は塗り背景（アクセントの淡色）+ 枠 + 明るいアイコン色、オフ時は背景なし + 暗いアイコン。
// 色だけに頼らず「塗り」の有無でも状態が分かるようにする（round-2 M10）。

import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { PALETTE } from "@/constants/brand";

/** オン時の塗り（accent #6CA1B5 の淡色）と明るいアイコン色。 */
export const MODE_ON_BG = "rgba(108, 161, 181, 0.28)";
export const MODE_ON_FG = "#CDEBF5";

export interface ModeToggleButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** アイコン右上の小さなバッジ（例: 1曲リピートの「1」）。 */
  badge?: string | null;
  size?: number;
}

export default function ModeToggleButton({
  icon,
  active,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  badge,
  size = 22,
}: ModeToggleButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active }}
      hitSlop={6}
      style={({ pressed }) => [styles.btn, active && styles.btnOn, pressed && styles.pressed]}
    >
      <View>
        <Ionicons name={icon} size={size} color={active ? MODE_ON_FG : PALETTE.textDim} />
        {badge ? <Text style={[styles.badge, active && styles.badgeOn]}>{badge}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  btnOn: {
    backgroundColor: MODE_ON_BG,
    borderColor: PALETTE.accent,
  },
  pressed: { opacity: 0.6 },
  badge: {
    position: "absolute",
    right: -6,
    top: -6,
    color: PALETTE.textDim,
    fontSize: 10,
    fontWeight: "800",
  },
  badgeOn: {
    color: MODE_ON_FG,
  },
});
