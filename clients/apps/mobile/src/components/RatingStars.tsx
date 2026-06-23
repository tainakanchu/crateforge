// タップで設定できる ★×5 のレーティングコントロール。
// 値は 0..5 の整数星（表示用）。0 = 未設定。
// 同じ星を再タップすると 0 にクリアする（例: ★★★ の 3 を再タップ → 0）。
// 実際の rating(0..100) への変換は呼び出し側で star*20 として行う。

import { View, Text, Pressable, StyleSheet } from "react-native";

import { PALETTE } from "@/constants/brand";

export interface RatingStarsProps {
  /** 現在の星数（0..5）。 */
  value: number;
  /** 星タップ時のコールバック。新しい星数（0..5）を渡す。 */
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
  return (
    <View
      style={styles.row}
      accessibilityRole="adjustable"
      accessibilityLabel="レーティング"
      accessibilityValue={{ min: 0, max: 5, now: value }}
    >
      {STARS.map((star) => {
        const filled = star <= value;
        return (
          <Pressable
            key={star}
            disabled={disabled}
            // 同じ星を再タップしたら 0 にクリア、それ以外はその星数に設定。
            onPress={() => onChange(star === value ? 0 : star)}
            accessibilityRole="button"
            accessibilityLabel={`星${star}`}
            hitSlop={6}
            style={({ pressed }) => [styles.starHit, pressed && !disabled && styles.pressed]}
          >
            <Text
              style={[
                { fontSize: size },
                styles.star,
                filled ? styles.starFilled : styles.starEmpty,
                disabled && styles.starDisabled,
              ]}
            >
              {filled ? "★" : "☆"}
            </Text>
          </Pressable>
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
    gap: 4,
  },
  starHit: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  pressed: {
    opacity: 0.6,
  },
  star: {
    lineHeight: undefined,
  },
  starFilled: {
    color: PALETTE.accent,
  },
  starEmpty: {
    color: PALETTE.textFaint,
  },
  starDisabled: {
    color: PALETTE.border,
  },
});
