// 検索画面（プレースホルダ）。
// TODO: 後続エージェントがスクリーンキーボード・検索結果一覧・即時検索を実装する。
// TV ではソフトウェアキーボードをバーチャルキーボードか D-pad で操作する。

import { View, Text, StyleSheet } from "react-native";
import { PALETTE, TV_FONT, TV_LAYOUT } from "@/theme/palette";

export default function SearchScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>検索</Text>
      <Text style={styles.placeholder}>準備中</Text>
      <Text style={styles.hint}>後続エージェントが検索機能を実装します</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.bg,
    paddingHorizontal: TV_LAYOUT.contentPaddingH,
    paddingVertical: TV_LAYOUT.contentPaddingV,
  },
  title: {
    fontSize: TV_FONT.xl,
    fontWeight: "700",
    color: PALETTE.teal,
    marginBottom: 24,
  },
  placeholder: {
    fontSize: TV_FONT.lg,
    color: PALETTE.textSub,
    marginBottom: 12,
  },
  hint: {
    fontSize: TV_FONT.sm,
    color: PALETTE.border,
  },
});
