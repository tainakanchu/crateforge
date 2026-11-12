// アートワーク無しのプレースホルダ。名前の頭文字 + 名前から決まる色（デスクトップと同系統）。

import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

export function placeholderInitial(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  if (!t) return "♪";
  const ch = Array.from(t)[0] ?? "♪";
  return ch.toUpperCase();
}

/** 名前の文字列ハッシュから決まる暗めの色相（同じ名前は常に同じ色）。 */
export function placeholderColor(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 32%, 30%)`;
}

export default function ArtPlaceholder({
  name,
  size,
  radius,
  style,
}: {
  name: string | null | undefined;
  size: number;
  radius: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        styles.box,
        { width: size, height: size, borderRadius: radius, backgroundColor: placeholderColor(name) },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.letter, { fontSize: Math.round(size * 0.42) }]}>{placeholderInitial(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
  letter: { color: "rgba(255,255,255,0.85)", fontWeight: "700" },
});
