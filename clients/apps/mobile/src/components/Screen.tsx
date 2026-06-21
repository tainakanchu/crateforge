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
  const padding: ViewStyle = {
    paddingTop: edges.includes("top") ? insets.top : 0,
    paddingBottom: edges.includes("bottom") ? insets.bottom : 0,
    paddingLeft: edges.includes("left") ? insets.left : 0,
    paddingRight: edges.includes("right") ? insets.right : 0,
  };
  return <View style={[styles.root, padding, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
});
