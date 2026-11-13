// シーク用バー。タップ/ドラッグで位置を決め、離したときに onSeek(positionMs) を呼ぶ。
// ドラッグ中は経過時間表示もドラッグ位置に追従する。

import { useState } from "react";
import { Text, View, StyleSheet } from "react-native";

import { PALETTE } from "@/constants/brand";
import { formatDuration } from "@crateforge/core";
import DragBar from "./DragBar";

export interface SeekBarProps {
  positionMs: number;
  durationMs: number;
  onSeek: (positionMs: number) => void;
  disabled?: boolean;
}

export default function SeekBar({ positionMs, durationMs, onSeek, disabled = false }: SeekBarProps) {
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const ratio = durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;
  const shownMs = dragRatio != null ? Math.round(dragRatio * durationMs) : positionMs;

  return (
    <View style={styles.wrap}>
      <DragBar
        value={ratio}
        disabled={disabled || durationMs <= 0}
        accessibilityLabel="シークバー"
        accessibilityValueText={`${formatDuration(shownMs)} / ${formatDuration(durationMs)}`}
        // ±10 秒相当の刻み。
        step={durationMs > 0 ? 10000 / durationMs : 0.05}
        onDragChange={setDragRatio}
        onCommit={(r) => onSeek(Math.round(r * durationMs))}
      />
      <View style={styles.times}>
        <Text style={styles.time}>{formatDuration(shownMs)}</Text>
        <Text style={styles.time}>{formatDuration(durationMs)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
  },
  times: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  time: {
    color: PALETTE.textDim,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
