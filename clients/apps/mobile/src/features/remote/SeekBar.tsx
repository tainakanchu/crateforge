// シーク用バー。タップ位置から positionMs を算出して onSeek に渡す。
// 追加依存なし（Pressable + onLayout で幅を取り、locationX で比率を出す）。

import { useState } from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import type { GestureResponderEvent, LayoutChangeEvent } from "react-native";

import { PALETTE } from "@/constants/brand";
import { formatDuration } from "@crateforge/core";

export interface SeekBarProps {
  positionMs: number;
  durationMs: number;
  onSeek: (positionMs: number) => void;
  disabled?: boolean;
}

export default function SeekBar({ positionMs, durationMs, onSeek, disabled = false }: SeekBarProps) {
  const [width, setWidth] = useState(0);
  const ratio = durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  };

  const onPress = (e: GestureResponderEvent) => {
    if (disabled || width <= 0 || durationMs <= 0) return;
    const x = Math.max(0, Math.min(width, e.nativeEvent.locationX));
    onSeek(Math.round((x / width) * durationMs));
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        onLayout={onLayout}
        disabled={disabled}
        accessibilityRole="adjustable"
        accessibilityLabel="シークバー"
        hitSlop={{ top: 12, bottom: 12 }}
        style={styles.track}
      >
        <View style={styles.trackBg} />
        <View style={[styles.fill, { width: `${ratio * 100}%` }]} />
      </Pressable>
      <View style={styles.times}>
        <Text style={styles.time}>{formatDuration(positionMs)}</Text>
        <Text style={styles.time}>{formatDuration(durationMs)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
  },
  track: {
    height: 28,
    justifyContent: "center",
  },
  trackBg: {
    ...StyleSheet.absoluteFill,
    top: 12,
    bottom: 12,
    borderRadius: 3,
    backgroundColor: PALETTE.surfaceAlt,
  },
  fill: {
    height: 4,
    borderRadius: 3,
    backgroundColor: PALETTE.accent,
  },
  times: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 2,
  },
  time: {
    color: PALETTE.textDim,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
