// 画面の土台。ダーク背景 + 上部セーフエリア余白を与える共通ラッパ。
// 各画面（slice）はこの中にコンテンツを並べるだけでよい。

import type { ReactNode } from "react";
import { View, StyleSheet } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PALETTE } from "@/constants/brand";

export type ScreenEdge = "top" | "bottom" | "left" | "right";

export interface ScreenProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** セーフエリア余白を付ける辺。既定は ["top"]。 */
  edges?: ScreenEdge[];
}

export default function Screen({ children, style, edges = ["top"] }: ScreenProps) {
  const insets = useSafeAreaInsets();
  // 指定された辺だけ padding を設定する（未指定の辺を 0 で上書きして style の paddingHorizontal を潰さない）。
  const padding: ViewStyle = {};
  if (edges.includes("top")) padding.paddingTop = insets.top;
  if (edges.includes("bottom")) padding.paddingBottom = insets.bottom;
  if (edges.includes("left")) padding.paddingLeft = insets.left;
  if (edges.includes("right")) padding.paddingRight = insets.right;
  return <View style={[styles.root, padding, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
});
