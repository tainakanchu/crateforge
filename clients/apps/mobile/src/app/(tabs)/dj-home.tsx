// DJ タブ（ランディング）。DJ モードの説明と開始ボタンを置き、
// 本体はフルスクリーンのスタックルート /dj に任せる（タブバー無しで操作面を最大化）。
// ファイル名を dj-home にしているのは、グループ (tabs) 配下の dj.tsx だと
// トップレベルの app/dj.tsx と同じ URL "/dj" にマッチして曖昧になるため。

import { Pressable, Text, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";

export default function DjTab() {
  const router = useRouter();

  return (
    <Screen>
      <View style={styles.content}>
        <Ionicons name="disc" size={64} color={BRAND.accent} />
        <Text style={styles.title}>DJ モード</Text>
        <Text style={styles.description}>
          2 デッキ + クロスフェーダーの簡易 DJ。曲をロードして CUE / SYNC / テンポ /
          ピッチベンドで軽くつなげます。
        </Text>
        <Text style={styles.description}>
          USB (OTG) で MIDI コントローラや DJM シリーズ等のミキサーを接続すれば、
          MIDI ラーンでフェーダーやボタンを割り当てて操作できます（Android）。
        </Text>
        <Pressable
          onPress={() => router.push("/dj")}
          accessibilityRole="button"
          accessibilityLabel="DJ モードを開始"
          style={({ pressed }) => [styles.startBtn, pressed && styles.pressed]}
        >
          <Ionicons name="play" size={18} color={BRAND.accentText} />
          <Text style={styles.startBtnText}>DJ モードを開始</Text>
        </Pressable>
        <Text style={styles.note}>
          開始するとライブラリの通常再生は一時停止します。
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 14,
  },
  title: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: "800",
  },
  description: {
    color: PALETTE.textDim,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: BRAND.accent,
  },
  startBtnText: {
    color: BRAND.accentText,
    fontSize: 15,
    fontWeight: "800",
  },
  note: {
    color: PALETTE.textFaint,
    fontSize: 11,
  },
  pressed: {
    opacity: 0.8,
  },
});
