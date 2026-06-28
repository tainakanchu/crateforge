// 常設 now-playing バー。コンテンツ列の下部に常時表示する。
// 現在曲が無い場合は何も描画しない。
// メタエリア（アートワーク＋曲名）を選択するとプレイヤー全画面へ遷移する。
// D-pad で操作できるよう、再生/一時停止・次へは Focusable コンポーネントを使用。

import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { usePlayer, useConnection, trackTitle, trackArtist } from "@crateforge/core";
import { Focusable } from "@/components/focus/Focusable";
import { PALETTE, TV_FONT, FOCUS_RING } from "@/theme/palette";

export function MiniPlayer() {
  const router = useRouter();
  const current = usePlayer((s) => s.current());
  const isPlaying = usePlayer((s) => s.isPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const client = useConnection((s) => s.client);

  // 曲が無いときは何も表示しない
  if (!current) return null;

  const progress = durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  return (
    <View style={styles.container}>
      {/* 再生進捗バー（上端に細いライン） */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` as `${number}%` }]} />
      </View>

      <View style={styles.row}>
        {/* アートワーク + 曲情報（選択でプレイヤー全画面へ） */}
        <Focusable
          onSelect={() => router.push("/player")}
          style={styles.metaArea}
          focusedStyle={styles.metaAreaFocused}
          accessibilityLabel="プレイヤーを開く"
        >
          {client ? (
            <Image
              source={client.artworkSource(current.trackId)}
              style={styles.artwork}
              contentFit="cover"
            />
          ) : (
            <View style={[styles.artwork, styles.artworkPlaceholder]} />
          )}
          <View style={styles.texts}>
            <Text style={styles.title} numberOfLines={1}>
              {trackTitle(current)}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {trackArtist(current)}
            </Text>
          </View>
        </Focusable>

        {/* コントロール（再生/停止・次へ） */}
        <View style={styles.controls}>
          <Focusable
            onSelect={() => toggle()}
            style={styles.ctrlBtn}
            focusedStyle={styles.ctrlBtnFocused}
            accessibilityLabel={isPlaying ? "一時停止" : "再生"}
          >
            <Ionicons
              name={isPlaying ? "pause" : "play"}
              size={28}
              color={PALETTE.text}
            />
          </Focusable>
          <Focusable
            onSelect={() => next()}
            style={styles.ctrlBtn}
            focusedStyle={styles.ctrlBtnFocused}
            accessibilityLabel="次の曲へ"
          >
            <Ionicons name="play-skip-forward" size={28} color={PALETTE.text} />
          </Focusable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
    backgroundColor: PALETTE.navBg,
  },
  progressTrack: {
    height: 3,
    backgroundColor: PALETTE.border,
  },
  progressFill: {
    height: 3,
    backgroundColor: PALETTE.teal,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingRight: 16,
  },
  metaArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 12,
    borderRadius: 8,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  metaAreaFocused: {
    borderColor: PALETTE.teal,
    backgroundColor: PALETTE.focusBg,
    borderRadius: 8,
  },
  artwork: {
    width: 52,
    height: 52,
    borderRadius: 6,
    backgroundColor: PALETTE.surface,
    flexShrink: 0,
  },
  artworkPlaceholder: {
    backgroundColor: PALETTE.surface,
  },
  texts: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: TV_FONT.sm,
    fontWeight: "600",
    color: PALETTE.text,
  },
  artist: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 3,
  },
  controls: {
    flexDirection: "row",
    gap: 8,
    flexShrink: 0,
  },
  ctrlBtn: {
    padding: 12,
    borderRadius: 8,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  ctrlBtnFocused: {
    borderColor: PALETTE.teal,
    backgroundColor: PALETTE.focusBg,
    borderRadius: 8,
  },
});
