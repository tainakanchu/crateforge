// Crateforge TV プレイヤー画面（Now Playing）。
// サイドナビなしの全画面で描画される（_layout.tsx の AppShell で制御）。
// 縦中央寄せ: アートワーク（画面高の ~45%）→ タイトル/アーティスト/アルバム →
// プログレスバー → 主操作（前/再生停止/次）→ 副操作（シャッフル/シーク/リピート）→ 戻る。

import { useWindowDimensions } from "react-native";
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import {
  usePlayer,
  useConnection,
  trackTitle,
  trackArtist,
  formatDuration,
} from "@crateforge/core";
import { Focusable } from "@/components/focus/Focusable";
import { PALETTE, TV_FONT, FOCUS_RING } from "@/theme/palette";

export default function PlayerScreen() {
  const router = useRouter();
  const { height: screenHeight } = useWindowDimensions();

  const client = useConnection((s) => s.client);
  const current = usePlayer((s) => s.current());
  const isPlaying = usePlayer((s) => s.isPlaying);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const seek = usePlayer((s) => s.seek);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const setRepeat = usePlayer((s) => s.setRepeat);
  const setShuffle = usePlayer((s) => s.setShuffle);

  // アートワークサイズ: 画面高の 45%、最大 520px
  const artSize = Math.min(Math.round(screenHeight * 0.45), 520);

  const progress = durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  // ±10 秒シーク
  const skip = (deltaMs: number) => {
    const target = positionMs + deltaMs;
    const clamped = durationMs > 0 ? Math.min(target, durationMs) : target;
    seek(Math.max(0, clamped));
  };

  // リピートを off → all → one → off で循環
  const cycleRepeat = () => {
    setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
  };

  // 曲なし状態
  if (!current) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.noTrack}>再生中の曲がありません</Text>
          <Focusable
            onSelect={() => router.back()}
            style={styles.backBtn}
            accessibilityLabel="ライブラリへ戻る"
            hasTVPreferredFocus
          >
            <Text style={styles.backText}>← ライブラリへ</Text>
          </Focusable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        {/* アートワーク */}
        <View style={[styles.artworkWrapper, { width: artSize, height: artSize }]}>
          {client ? (
            <Image
              source={client.artworkSource(current.trackId)}
              style={styles.artwork}
              contentFit="cover"
            />
          ) : (
            <View style={[styles.artwork, styles.artworkPlaceholder]} />
          )}
        </View>

        {/* タイトル・アーティスト・アルバム */}
        <Text style={styles.trackName} numberOfLines={2}>
          {trackTitle(current)}
        </Text>
        <Text style={styles.trackArtist} numberOfLines={1}>
          {trackArtist(current)}
        </Text>
        {current.album != null && (
          <Text style={styles.trackAlbum} numberOfLines={1}>
            {current.album}
          </Text>
        )}

        {/* プログレスバー + 時間 */}
        <View style={styles.progressRow}>
          <Text style={styles.timeText}>{formatDuration(positionMs)}</Text>
          <View style={styles.progressBg}>
            <View style={[styles.progressFg, { flex: progress }]} />
            <View style={{ flex: Math.max(0, 1 - progress) }} />
          </View>
          <Text style={styles.timeText}>{formatDuration(durationMs)}</Text>
        </View>

        {/* 主操作: 前 / 再生停止 / 次 */}
        <View style={styles.primaryControls}>
          <Focusable
            onSelect={() => prev()}
            style={styles.ctrlBtn}
            accessibilityLabel="前の曲"
          >
            <Text style={styles.ctrlText}>⏮</Text>
          </Focusable>
          <Focusable
            onSelect={() => toggle()}
            style={styles.ctrlBtnPrimary}
            focusedStyle={styles.ctrlBtnPrimaryFocused}
            hasTVPreferredFocus
            accessibilityLabel={isPlaying ? "一時停止" : "再生"}
          >
            <Text style={styles.ctrlTextPrimary}>{isPlaying ? "⏸" : "▶"}</Text>
          </Focusable>
          <Focusable
            onSelect={() => next()}
            style={styles.ctrlBtn}
            accessibilityLabel="次の曲"
          >
            <Text style={styles.ctrlText}>⏭</Text>
          </Focusable>
        </View>

        {/* 副操作: シャッフル / −10s / +10s / リピート */}
        <View style={styles.secondaryControls}>
          <Focusable
            onSelect={() => setShuffle(!shuffle)}
            style={[styles.ctrlBtnSm, shuffle && styles.ctrlBtnSmActive]}
            accessibilityLabel="シャッフル"
          >
            <Text style={[styles.ctrlTextSm, shuffle && styles.ctrlTextSmActive]}>🔀</Text>
          </Focusable>
          <Focusable
            onSelect={() => skip(-10000)}
            style={styles.ctrlBtnSm}
            accessibilityLabel="-10秒"
          >
            <Text style={styles.ctrlTextSm}>−10s</Text>
          </Focusable>
          <Focusable
            onSelect={() => skip(10000)}
            style={styles.ctrlBtnSm}
            accessibilityLabel="+10秒"
          >
            <Text style={styles.ctrlTextSm}>+10s</Text>
          </Focusable>
          <Focusable
            onSelect={cycleRepeat}
            style={[styles.ctrlBtnSm, repeat !== "off" && styles.ctrlBtnSmActive]}
            accessibilityLabel="リピート"
          >
            <Text style={[styles.ctrlTextSm, repeat !== "off" && styles.ctrlTextSmActive]}>
              {repeat === "one" ? "🔂" : "🔁"}
            </Text>
          </Focusable>
        </View>

        {repeat !== "off" && (
          <Text style={styles.repeatHint}>
            {repeat === "one" ? "1曲リピート" : "全曲リピート"}
          </Text>
        )}

        {/* 戻るボタン */}
        <Focusable
          onSelect={() => router.back()}
          style={styles.backBtn}
          accessibilityLabel="ライブラリへ戻る"
        >
          <Text style={styles.backText}>← ライブラリへ</Text>
        </Focusable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 32,
  },
  noTrack: {
    fontSize: TV_FONT.lg,
    color: PALETTE.textSub,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 80,
    paddingVertical: 24,
    gap: 16,
  },
  artworkWrapper: {
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 8,
  },
  artwork: {
    width: "100%",
    height: "100%",
  },
  artworkPlaceholder: {
    backgroundColor: PALETTE.surface,
  },
  trackName: {
    fontSize: TV_FONT.xl,
    fontWeight: "700",
    color: PALETTE.text,
    textAlign: "center",
    lineHeight: TV_FONT.xl * 1.2,
    maxWidth: 900,
  },
  trackArtist: {
    fontSize: TV_FONT.lg,
    color: PALETTE.teal,
    textAlign: "center",
    maxWidth: 900,
  },
  trackAlbum: {
    fontSize: TV_FONT.md,
    color: PALETTE.textSub,
    textAlign: "center",
    maxWidth: 900,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    width: "100%",
    maxWidth: 900,
    marginTop: 8,
  },
  progressBg: {
    flex: 1,
    height: 8,
    backgroundColor: PALETTE.surface,
    borderRadius: 4,
    flexDirection: "row",
    overflow: "hidden",
  },
  progressFg: {
    backgroundColor: PALETTE.teal,
    borderRadius: 4,
  },
  timeText: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    fontVariant: ["tabular-nums"],
    minWidth: 80,
    textAlign: "center",
  },
  primaryControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    marginTop: 8,
  },
  ctrlBtn: {
    paddingVertical: 20,
    paddingHorizontal: 36,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  ctrlBtnPrimary: {
    paddingVertical: 24,
    paddingHorizontal: 52,
    borderRadius: 12,
    backgroundColor: PALETTE.teal,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  ctrlBtnPrimaryFocused: {
    borderColor: PALETTE.text,
    backgroundColor: PALETTE.teal,
    borderRadius: 12,
  },
  ctrlText: {
    fontSize: TV_FONT.xl,
    color: PALETTE.text,
    textAlign: "center",
  },
  ctrlTextPrimary: {
    fontSize: TV_FONT.xl,
    color: PALETTE.bg,
    fontWeight: "700",
    textAlign: "center",
  },
  secondaryControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginTop: 4,
  },
  ctrlBtnSm: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  ctrlBtnSmActive: {
    borderColor: PALETTE.teal,
  },
  ctrlTextSm: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  ctrlTextSmActive: {
    color: PALETTE.teal,
  },
  repeatHint: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
  },
  backBtn: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: PALETTE.border,
  },
  backText: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
  },
});
