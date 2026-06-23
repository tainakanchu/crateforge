// ミニプレイヤー。ルートレイアウトに置き、全画面で現在再生中の曲を小さく重ねて表示する。
// タップで全画面プレイヤー（/player）へ。現在曲が無ければ何も描画しない。
// - タブ配下（(tabs) 内のルート）ではタブバーの上に置く。
// - スタック画面（/artist /album /folder 等）では画面下端（セーフエリア）の上に置く。
// - 全画面プレイヤー（/player モーダル）・オンボーディング（/connect）では表示しない。

import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useSegments } from "expo-router";

import { PALETTE } from "@/constants/brand";
import { trackTitle, trackArtist, usePlayer } from "@crateforge/core";
import Artwork from "@/components/Artwork";
import IconButton from "@/components/IconButton";

// 標準的なタブバーの高さ目安（OS により多少前後するが重なり防止には十分）。
const TAB_BAR_HEIGHT = 49;

// ミニプレイヤーを隠すルート（最上位セグメントで判定）。
// /player（モーダル全画面プレイヤー）と /connect（オンボーディング）では出さない。
const HIDDEN_ROOTS = new Set(["player", "connect"]);

export default function MiniPlayer() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const segments = useSegments();
  const current = usePlayer((s) => s.current());
  const isPlaying = usePlayer((s) => s.isPlaying);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const toggle = usePlayer((s) => s.toggle);

  if (!current) return null;
  // 現在ルートの最上位セグメント。タブ配下は "(tabs)"、スタックは "artist" 等。
  const root = segments[0];
  if (root != null && HIDDEN_ROOTS.has(root)) return null;

  // タブ配下のみタブバー分の余白を足す。スタック画面はセーフエリアの上に置く。
  const onTabs = root === "(tabs)";
  const bottom = (onTabs ? TAB_BAR_HEIGHT : 0) + insets.bottom;
  const progress =
    durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  return (
    <Pressable
      onPress={() => router.push("/player")}
      accessibilityRole="button"
      accessibilityLabel="プレイヤーを開く"
      style={[styles.bar, { bottom }]}
    >
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
      <View style={styles.content}>
        <Artwork track={current} size={40} radius={5} />
        <View style={styles.texts}>
          <Text style={styles.title} numberOfLines={1}>
            {trackTitle(current)}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {trackArtist(current)}
          </Text>
        </View>
        <IconButton
          name={isPlaying ? "pause" : "play"}
          onPress={toggle}
          size={26}
          color={PALETTE.accent}
          accessibilityLabel={isPlaying ? "一時停止" : "再生"}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: PALETTE.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PALETTE.border,
  },
  progressTrack: {
    height: 2,
    backgroundColor: PALETTE.border,
  },
  progressFill: {
    height: 2,
    backgroundColor: PALETTE.accent,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 12,
  },
  texts: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: PALETTE.text,
    fontSize: 14,
    fontWeight: "600",
  },
  artist: {
    color: PALETTE.textDim,
    fontSize: 12,
    marginTop: 2,
  },
});
