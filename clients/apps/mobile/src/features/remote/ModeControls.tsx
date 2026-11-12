// Remote 画面の音量・シャッフル・リピート。ホストが値を報告しない項目（旧ホスト）は出さない。
// 各ボタンは 44pt 以上。

import { Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { BRAND, PALETTE } from "@/constants/brand";
import type { PlaybackState, RepeatMode } from "@crateforge/core";
import DragBar from "./DragBar";

export const REPEAT_LABEL: Record<RepeatMode, string> = {
  off: "リピートなし",
  all: "全曲リピート",
  one: "1曲リピート",
};

export function nextRepeat(mode: RepeatMode): RepeatMode {
  return mode === "off" ? "all" : mode === "all" ? "one" : "off";
}

export interface ModeControlsProps {
  state: Pick<PlaybackState, "volume" | "shuffle" | "repeat"> | undefined;
  onVolume: (volume: number) => void;
  onShuffle: (on: boolean) => void;
  onRepeat: (mode: RepeatMode) => void;
}

export default function ModeControls({ state, onVolume, onShuffle, onRepeat }: ModeControlsProps) {
  const volume = state?.volume;
  const shuffle = state?.shuffle;
  const repeat = state?.repeat;
  if (volume == null && shuffle == null && repeat == null) return null;

  return (
    <View style={styles.wrap}>
      {shuffle != null || repeat != null ? (
        <View style={styles.row}>
          {shuffle != null ? (
            <Pressable
              onPress={() => onShuffle(!shuffle)}
              accessibilityRole="button"
              accessibilityLabel={shuffle ? "シャッフル（オン）" : "シャッフル（オフ）"}
              accessibilityState={{ selected: shuffle }}
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
            >
              <Ionicons name="shuffle" size={24} color={shuffle ? BRAND.accent : PALETTE.textDim} />
            </Pressable>
          ) : null}
          {repeat != null ? (
            <Pressable
              onPress={() => onRepeat(nextRepeat(repeat))}
              accessibilityRole="button"
              accessibilityLabel={`リピート（${REPEAT_LABEL[repeat]}）`}
              accessibilityHint="タップで切り替え"
              accessibilityState={{ selected: repeat !== "off" }}
              style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
            >
              <Ionicons
                name={repeat === "one" ? "repeat-outline" : "repeat"}
                size={24}
                color={repeat !== "off" ? BRAND.accent : PALETTE.textDim}
              />
              {repeat === "one" ? <Text style={styles.badge}>1</Text> : null}
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {volume != null ? (
        <View style={styles.volRow}>
          <Ionicons
            name={volume <= 0 ? "volume-mute" : "volume-medium"}
            size={22}
            color={PALETTE.textDim}
          />
          <View style={styles.volBar}>
            <DragBar
              value={volume}
              accessibilityLabel="音量"
              accessibilityValueText={`${Math.round(volume * 100)}%`}
              step={0.05}
              onCommit={onVolume}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    gap: 4,
  },
  row: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 24,
  },
  btn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.6 },
  badge: {
    position: "absolute",
    right: 6,
    top: 6,
    color: BRAND.accent,
    fontSize: 11,
    fontWeight: "700",
  },
  volRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  volBar: { flex: 1 },
});
