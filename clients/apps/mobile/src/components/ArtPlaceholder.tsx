// アートワーク無しのプレースホルダ。名前の頭文字 + 名前から決まる色（デスクトップと同系統）。
// 頭文字と色の決め方は core/src/lib/artPlaceholder.ts（TV と共有）。

import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { placeholderColor, placeholderInitial } from "@crateforge/core";

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
