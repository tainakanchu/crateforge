// 常設ミニ再生バー。サイドナビ下部に常時表示する。
// 現在曲が無い場合は何も描画しない。
// D-pad で操作できるよう、再生/一時停止・次へは Focusable コンポーネントを使用。

import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

import { usePlayer, useConnection, trackTitle, trackArtist } from "@crateforge/core";
import { Focusable } from "@/components/focus/Focusable";
import { PALETTE, TV_FONT, TV_LAYOUT } from "@/theme/palette";

export function MiniPlayer() {
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
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>

      {/* アートワーク + 曲情報 */}
      <View style={styles.meta}>
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
      </View>

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
            size={22}
            color={PALETTE.text}
          />
        </Focusable>
        <Focusable
          onSelect={() => next()}
          style={styles.ctrlBtn}
          focusedStyle={styles.ctrlBtnFocused}
          accessibilityLabel="次の曲へ"
        >
          <Ionicons name="play-skip-forward" size={22} color={PALETTE.text} />
        </Focusable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
    paddingBottom: 8,
  },
  progressTrack: {
    height: 2,
    backgroundColor: PALETTE.border,
    marginBottom: 8,
  },
  progressFill: {
    height: 2,
    backgroundColor: PALETTE.teal,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: TV_LAYOUT.sideNavPaddingH,
    gap: 10,
    marginBottom: 8,
  },
  artwork: {
    width: 44,
    height: 44,
    borderRadius: 4,
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
    fontSize: TV_FONT.xs,
    fontWeight: "600",
    color: PALETTE.text,
  },
  artist: {
    fontSize: 15,
    color: PALETTE.textSub,
    marginTop: 2,
  },
  controls: {
    flexDirection: "row",
    paddingHorizontal: TV_LAYOUT.sideNavPaddingH,
    gap: 8,
  },
  ctrlBtn: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "transparent",
  },
  ctrlBtnFocused: {
    borderColor: PALETTE.teal,
    backgroundColor: PALETTE.focusBg,
    borderRadius: 8,
  },
});
