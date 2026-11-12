// Remote 画面の音量・シャッフル・リピート。ホストが値を報告しない項目（旧ホスト）は出さない。
// 各ボタンは 44pt 以上。

import { View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { PALETTE } from "@/constants/brand";
import ModeToggleButton from "@/components/ModeToggleButton";
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
            <ModeToggleButton
              icon="shuffle"
              size={24}
              active={shuffle}
              onPress={() => onShuffle(!shuffle)}
              accessibilityLabel={shuffle ? "シャッフル（オン）" : "シャッフル（オフ）"}
            />
          ) : null}
          {repeat != null ? (
            <ModeToggleButton
              icon="repeat"
              size={24}
              active={repeat !== "off"}
              badge={repeat === "one" ? "1" : null}
              onPress={() => onRepeat(nextRepeat(repeat))}
              accessibilityLabel={`リピート（${REPEAT_LABEL[repeat]}）`}
              accessibilityHint="タップで切り替え"
            />
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
  volRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  volBar: { flex: 1 },
});
