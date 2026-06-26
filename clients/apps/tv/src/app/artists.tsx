// アーティスト一覧画面（プレースホルダ）。
// TODO: 後続エージェントがアーティストリスト・アーティスト詳細・楽曲一覧を実装する。

import { View, Text, StyleSheet } from "react-native";
import { PALETTE, TV_FONT, TV_LAYOUT } from "@/theme/palette";

export default function ArtistsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>アーティスト</Text>
      <Text style={styles.placeholder}>準備中</Text>
      <Text style={styles.hint}>後続エージェントがアーティスト一覧を実装します</Text>
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
