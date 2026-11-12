// タップで設定できる ★×5 のレーティングコントロール。
// 値は 0..5（0.5 刻み、半星対応）。0 = 未設定。
// 星の左半分 = 半星、右半分 = 整数星。同じ値を再タップすると 0 にクリアする。
// 実際の rating(0..100) への変換は呼び出し側で star*20 として行う。
// 半星のタップ領域が狭い（18px 程度）と押し分けにくいので、星の箱を広めに取り縦にも hitSlop を足す。
// スクリーンリーダーでは adjustable（増減ジェスチャ = 0.5 刻み）で操作できる。

import { View, Text, Pressable, StyleSheet, type AccessibilityActionEvent } from "react-native";

import { PALETTE } from "@/constants/brand";

export interface RatingStarsProps {
  /** 現在の星数（0..5、0.5 刻み）。 */
  value: number;
  /** 星タップ時のコールバック。新しい星数（0..5、0.5 刻み）を渡す。 */
  onChange: (stars: number) => void;
  /** 操作不可（オフライン等）。淡色表示にしてタップを無効化する。 */
  disabled?: boolean;
  /** 1 つの星のフォントサイズ。 */
  size?: number;
}

const STARS = [1, 2, 3, 4, 5] as const;

export default function RatingStars({
  value,
  onChange,
  disabled = false,
  size = 28,
}: RatingStarsProps) {
  // 各星の左半分 = n-0.5、右半分 = n。同じ値を再タップすると 0 にクリア。
  const press = (v: number) => onChange(v === value ? 0 : v);
  // 1 星の箱。半星 1 つあたり (size + 18) / 2 ≒ 22px（size=26 時）の幅を確保する。
  const box = size + 18;
  // スクリーンリーダーの増減（0.5 刻み、0..5 にクランプ）。
  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (disabled) return;
    const step = e.nativeEvent.actionName === "increment" ? 0.5 : e.nativeEvent.actionName === "decrement" ? -0.5 : 0;
    if (step === 0) return;
    const next = Math.max(0, Math.min(5, value + step));
    if (next !== value) onChange(next);
  };
  return (
    <View
      style={styles.row}
      accessibilityRole="adjustable"
      accessibilityLabel="評価"
      accessibilityValue={{ min: 0, max: 5, now: value, text: value > 0 ? `星${value}` : "未評価" }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={onAccessibilityAction}
      accessibilityState={{ disabled }}
    >
      {STARS.map((star) => {
        const fill = value >= star ? 1 : value >= star - 0.5 ? 0.5 : 0;
        return (
          <View key={star} style={{ width: box, height: box + 8 }}>
            <View style={styles.starLayer} pointerEvents="none">
              <Text style={[{ fontSize: size }, styles.starEmpty, disabled && styles.starDisabled]}>☆</Text>
              {fill > 0 ? (
                <View style={[styles.fillClip, { width: box * fill }]}>
                  <Text
                    style={[
                      { fontSize: size, width: box },
                      styles.starFilled,
                      disabled && styles.starDisabled,
                    ]}
                  >
                    ★
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={styles.halves}>
              <Pressable
                disabled={disabled}
                onPress={() => press(star - 0.5)}
                accessibilityRole="button"
                accessibilityLabel={`星${star - 0.5}`}
                hitSlop={{ top: 10, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => [styles.half, pressed && !disabled && styles.pressed]}
              />
              <Pressable
                disabled={disabled}
                onPress={() => press(star)}
                accessibilityRole="button"
                accessibilityLabel={`星${star}`}
                hitSlop={{ top: 10, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => [styles.half, pressed && !disabled && styles.pressed]}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  starLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  fillClip: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    overflow: "hidden",
    justifyContent: "center",
  },
  halves: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
  },
  half: {
    flex: 1,
  },
  pressed: {
    opacity: 0.6,
  },
  starFilled: {
    color: PALETTE.accent,
    textAlign: "center",
  },
  starEmpty: {
    color: PALETTE.textFaint,
  },
  starDisabled: {
    color: PALETTE.border,
  },
});
