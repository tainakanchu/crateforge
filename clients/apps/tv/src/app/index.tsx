// Crateforge TV ホーム画面（プレースホルダ）。
// 接続済みの場合に最初に表示される画面。
// TODO: 後続エージェントが最近再生した曲・おすすめ・クイックアクセスを実装する。
// 実装時は usePlayer / useConnection を使い、キュー設定後に /player へ遷移する。

import { View, Text, StyleSheet } from "react-native";
import { useConnection } from "@crateforge/core";
import { PALETTE, TV_FONT, TV_LAYOUT } from "@/theme/palette";

export default function HomeScreen() {
  const baseUrl = useConnection((s) => s.baseUrl);

  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>ようこそ、Crateforge へ</Text>
      {baseUrl ? (
        <Text style={styles.connected}>接続先: {baseUrl}</Text>
      ) : null}
      <Text style={styles.placeholder}>準備中</Text>
      <Text style={styles.hint}>
        後続エージェントが最近再生した曲・おすすめ等を実装します。{"\n"}
        左のナビから各ライブラリ画面を選んでください。
      </Text>
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
  welcome: {
    fontSize: TV_FONT.xl,
    fontWeight: "700",
    color: PALETTE.teal,
    marginBottom: 16,
  },
  connected: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    marginBottom: 32,
    fontFamily: "monospace",
  },
  placeholder: {
    fontSize: TV_FONT.lg,
    color: PALETTE.textSub,
    marginBottom: 12,
  },
  hint: {
    fontSize: TV_FONT.sm,
    color: PALETTE.border,
    lineHeight: TV_FONT.sm * 1.6,
  },
});
