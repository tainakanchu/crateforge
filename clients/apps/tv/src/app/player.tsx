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
  const seek = usePlayer((s) => s.seek);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);
  const setRepeat = usePlayer((s) => s.setRepeat);
  const setShuffle = usePlayer((s) => s.setShuffle);

  const [focusedBtn, setFocusedBtn] = useState<string | null>(null);

  const progress = durationMs > 0 ? positionMs / durationMs : 0;

  // ±10 秒シーク。duration が判明していれば末尾を超えないようにクランプ。
  const skip = (deltaMs: number) => {
    const target = positionMs + deltaMs;
    const clamped = durationMs > 0 ? Math.min(target, durationMs) : target;
    seek(Math.max(0, clamped));
  };

  // リピートを off → all → one → off で循環させる。
  const cycleRepeat = () => {
    setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
  };

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

          {/* プログレスバー + ±10秒シーク（D-pad でフォーカスして決定） */}
          <View style={styles.progressWrapper}>
            <Text style={styles.timeText}>{formatDuration(positionMs)}</Text>
            <ControlButton
              label="−10"
              id="back10"
              focusedBtn={focusedBtn}
              setFocusedBtn={setFocusedBtn}
              onPress={() => skip(-10000)}
              small
            />
            <View style={styles.progressBg}>
              <View style={[styles.progressFg, { flex: progress }]} />
              <View style={{ flex: 1 - progress }} />
            </View>
            <ControlButton
              label="+10"
              id="fwd10"
              focusedBtn={focusedBtn}
              setFocusedBtn={setFocusedBtn}
              onPress={() => skip(10000)}
              small
            />
            <Text style={styles.timeText}>{formatDuration(durationMs)}</Text>
          </View>

          {/* コントロール: シャッフル / 前 / 再生停止 / 次 / リピート */}
          <View style={styles.controls}>
            <ControlButton
              label="🔀"
              id="shuffle"
              focusedBtn={focusedBtn}
              setFocusedBtn={setFocusedBtn}
              onPress={() => setShuffle(!shuffle)}
              active={shuffle}
            />
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
            <ControlButton
              label={repeat === "one" ? "🔂" : "🔁"}
              id="repeat"
              focusedBtn={focusedBtn}
              setFocusedBtn={setFocusedBtn}
              onPress={cycleRepeat}
              active={repeat !== "off"}
            />
          </View>
          {repeat === "one" ? (
            <Text style={styles.repeatHint}>1曲リピート</Text>
          ) : repeat === "all" ? (
            <Text style={styles.repeatHint}>全曲リピート</Text>
          ) : null}

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
  /** トグルが ON のときに teal で強調する（シャッフル/リピート用）。 */
  active?: boolean;
  /** ±10秒シークなど小型ボタン用にパディング/フォントを縮める。 */
  small?: boolean;
  hasTVPreferredFocus?: boolean;
}

function ControlButton({
  label,
  id,
  focusedBtn,
  setFocusedBtn,
  onPress,
  primary,
  active,
  small,
  hasTVPreferredFocus,
}: ControlButtonProps) {
  const isFocused = focusedBtn === id;
  return (
    <Pressable
      style={[
        styles.ctrlBtn,
        primary && styles.ctrlBtnPrimary,
        small && styles.ctrlBtnSmall,
        // active は非フォーカス時に teal の枠で「ON」を示す。フォーカス時は
        // focused スタイルが枠/背景を上書きするので最後に置く。
        active && !isFocused && styles.ctrlBtnActive,
        isFocused && styles.ctrlBtnFocused,
      ]}
      onFocus={() => setFocusedBtn(id)}
      onBlur={() => setFocusedBtn(null)}
      onPress={onPress}
      hasTVPreferredFocus={hasTVPreferredFocus}
    >
      <Text
        style={[
          styles.ctrlBtnText,
          small && styles.ctrlBtnTextSmall,
          primary && styles.ctrlBtnTextPrimary,
          active && styles.ctrlBtnTextActive,
        ]}
      >
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
    gap: 20,
    marginTop: 32,
    alignItems: "center",
  },
  ctrlBtn: {
    paddingVertical: 20,
    paddingHorizontal: 36,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 3,
    borderColor: "transparent",
  },
  ctrlBtnPrimary: {
    paddingVertical: 24,
    paddingHorizontal: 52,
    backgroundColor: PALETTE.teal,
  },
  ctrlBtnSmall: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  ctrlBtnActive: {
    borderColor: PALETTE.teal,
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
  ctrlBtnTextSmall: {
    fontSize: TV_FONT.xs,
    fontVariant: ["tabular-nums"],
  },
  ctrlBtnTextPrimary: {
    color: PALETTE.bg,
    fontWeight: "700",
  },
  ctrlBtnTextActive: {
    color: PALETTE.teal,
  },
  repeatHint: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 12,
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
