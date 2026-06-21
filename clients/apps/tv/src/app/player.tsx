// Crateforge TV プレイヤー画面（Now Playing）。
// 大きなアートワーク + タイトル/アーティスト + D-pad 操作可能コントロール。

import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
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
import { PALETTE, TV_FONT } from "@/theme/palette";

export default function PlayerScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  const current = usePlayer((s) => s.current());
  const isPlaying = usePlayer((s) => s.isPlaying);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);

  const [focusedBtn, setFocusedBtn] = useState<string | null>(null);

  const progress = durationMs > 0 ? positionMs / durationMs : 0;

  if (!current) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.noTrack}>再生中の曲がありません</Text>
          <ControlButton
            label="ライブラリへ戻る"
            id="back"
            focusedBtn={focusedBtn}
            setFocusedBtn={setFocusedBtn}
            onPress={() => router.back()}
            hasTVPreferredFocus
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        {/* アートワーク */}
        <View style={styles.artworkWrapper}>
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

        {/* メタ情報 */}
        <View style={styles.info}>
          <Text style={styles.trackName} numberOfLines={2}>
            {trackTitle(current)}
          </Text>
          <Text style={styles.trackArtist} numberOfLines={1}>
            {trackArtist(current)}
          </Text>
          {current.album && (
            <Text style={styles.trackAlbum} numberOfLines={1}>
              {current.album}
            </Text>
          )}

          {/* プログレスバー */}
          <View style={styles.progressWrapper}>
            <Text style={styles.timeText}>{formatDuration(positionMs)}</Text>
            <View style={styles.progressBg}>
              <View style={[styles.progressFg, { flex: progress }]} />
              <View style={{ flex: 1 - progress }} />
            </View>
            <Text style={styles.timeText}>{formatDuration(durationMs)}</Text>
          </View>

          {/* コントロール */}
          <View style={styles.controls}>
            <ControlButton
              label="⏮"
              id="prev"
              focusedBtn={focusedBtn}
              setFocusedBtn={setFocusedBtn}
              onPress={() => prev()}
            />
            <ControlButton
              label={isPlaying ? "⏸" : "▶"}
              id="toggle"
              focusedBtn={focusedBtn}
              setFocusedBtn={setFocusedBtn}
              onPress={() => toggle()}
              primary
              hasTVPreferredFocus
            />
            <ControlButton
              label="⏭"
              id="next"
              focusedBtn={focusedBtn}
              setFocusedBtn={setFocusedBtn}
              onPress={() => next()}
            />
          </View>

          <Pressable
            style={[
              styles.backBtn,
              focusedBtn === "back" && { borderColor: PALETTE.teal },
            ]}
            onFocus={() => setFocusedBtn("back")}
            onBlur={() => setFocusedBtn(null)}
            onPress={() => router.back()}
          >
            <Text style={styles.backBtnText}>← ライブラリへ</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

interface ControlButtonProps {
  label: string;
  id: string;
  focusedBtn: string | null;
  setFocusedBtn: (id: string | null) => void;
  onPress: () => void;
  primary?: boolean;
  hasTVPreferredFocus?: boolean;
}

function ControlButton({
  label,
  id,
  focusedBtn,
  setFocusedBtn,
  onPress,
  primary,
  hasTVPreferredFocus,
}: ControlButtonProps) {
  const isFocused = focusedBtn === id;
  return (
    <Pressable
      style={[
        styles.ctrlBtn,
        primary && styles.ctrlBtnPrimary,
        isFocused && styles.ctrlBtnFocused,
      ]}
      onFocus={() => setFocusedBtn(id)}
      onBlur={() => setFocusedBtn(null)}
      onPress={onPress}
      hasTVPreferredFocus={hasTVPreferredFocus}
    >
      <Text style={[styles.ctrlBtnText, primary && styles.ctrlBtnTextPrimary]}>
        {label}
      </Text>
    </Pressable>
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
    flexDirection: "row",
    padding: 64,
    gap: 64,
  },
  artworkWrapper: {
    width: 480,
    aspectRatio: 1,
    alignSelf: "center",
  },
  artwork: {
    width: "100%",
    height: "100%",
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
  },
  artworkPlaceholder: {
    backgroundColor: PALETTE.surface,
  },
  info: {
    flex: 1,
    justifyContent: "center",
    gap: 16,
  },
  trackName: {
    fontSize: TV_FONT.xl,
    fontWeight: "700",
    color: PALETTE.text,
    lineHeight: TV_FONT.xl * 1.2,
  },
  trackArtist: {
    fontSize: TV_FONT.lg,
    color: PALETTE.teal,
    marginTop: 8,
  },
  trackAlbum: {
    fontSize: TV_FONT.md,
    color: PALETTE.textSub,
  },
  progressWrapper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginTop: 24,
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
    minWidth: 72,
  },
  controls: {
    flexDirection: "row",
    gap: 24,
    marginTop: 32,
    alignItems: "center",
  },
  ctrlBtn: {
    paddingVertical: 20,
    paddingHorizontal: 40,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 3,
    borderColor: "transparent",
  },
  ctrlBtnPrimary: {
    paddingVertical: 24,
    paddingHorizontal: 56,
    backgroundColor: PALETTE.teal,
  },
  ctrlBtnFocused: {
    borderColor: PALETTE.text,
    backgroundColor: PALETTE.focusBg,
  },
  ctrlBtnText: {
    fontSize: TV_FONT.lg,
    color: PALETTE.text,
    textAlign: "center",
  },
  ctrlBtnTextPrimary: {
    color: PALETTE.bg,
    fontWeight: "700",
  },
  backBtn: {
    alignSelf: "flex-start",
    marginTop: 32,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: PALETTE.border,
  },
  backBtnText: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
  },
});
