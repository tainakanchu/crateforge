// DJ 用の横フェーダー。追加依存なしで View のレスポンダシステムを直接使い、
// タップ位置・ドラッグ位置から 0..1 の値を出す（SeekBar と同じ locationX 方式）。
// fillFrom="center" でテンポフェーダーのような「中央基準」の塗りにできる。

import { useRef, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import type { GestureResponderEvent, LayoutChangeEvent } from "react-native";

import { PALETTE } from "@/constants/brand";
import { clamp01 } from "./math";

export interface FaderBarProps {
  /** 現在値 (0..1)。 */
  value: number;
  onChange: (value: number) => void;
  /** 端からの塗り(既定) or 中央からの塗り（テンポ用）。 */
  fillFrom?: "start" | "center";
  /** 左右端に出す小ラベル（例: "A" / "B"）。 */
  startLabel?: string;
  endLabel?: string;
  disabled?: boolean;
  accessibilityLabel: string;
}

/** サムの直径（px）。 */
const THUMB = 22;

export default function FaderBar({
  value,
  onChange,
  fillFrom = "start",
  startLabel,
  endLabel,
  disabled = false,
  accessibilityLabel,
}: FaderBarProps) {
  const [width, setWidth] = useState(0);
  // ドラッグ中の連続 onChange で再レンダリングされても responder を維持できるよう、
  // 幅は ref にも持つ（onResponderMove 内では最新値を参照）。
  const widthRef = useRef(0);

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };

  const handleTouch = (e: GestureResponderEvent) => {
    const w = widthRef.current;
    if (disabled || w <= 0) return;
    onChange(clamp01(e.nativeEvent.locationX / w));
  };

  const v = clamp01(value);
  const thumbLeft = Math.max(0, Math.min(width - THUMB, v * width - THUMB / 2));

  // 塗り: start 起点は [0, v]、center 起点は [0.5, v]（左右どちらへも伸びる）。
  const fillLeftRatio = fillFrom === "center" ? Math.min(0.5, v) : 0;
  const fillWidthRatio = fillFrom === "center" ? Math.abs(v - 0.5) : v;

  return (
    <View style={styles.row}>
      {startLabel != null ? <Text style={styles.edgeLabel}>{startLabel}</Text> : null}
      <View
        onLayout={onLayout}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={handleTouch}
        onResponderMove={handleTouch}
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
        style={[styles.track, disabled && styles.disabled]}
      >
        <View style={styles.trackBg} />
        {fillFrom === "center" ? <View style={styles.centerTick} /> : null}
        <View
          style={[
            styles.fill,
            {
              left: `${fillLeftRatio * 100}%`,
              width: `${fillWidthRatio * 100}%`,
            },
          ]}
        />
        <View style={[styles.thumb, { left: thumbLeft }]} />
      </View>
      {endLabel != null ? <Text style={styles.edgeLabel}>{endLabel}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  track: {
    flex: 1,
    height: 36,
    justifyContent: "center",
  },
  disabled: {
    opacity: 0.4,
  },
  trackBg: {
    ...StyleSheet.absoluteFill,
    top: 15,
    bottom: 15,
    borderRadius: 3,
    backgroundColor: PALETTE.surfaceAlt,
  },
  centerTick: {
    position: "absolute",
    left: "50%",
    top: 8,
    bottom: 8,
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: PALETTE.border,
  },
  fill: {
    position: "absolute",
    top: 15,
    bottom: 15,
    borderRadius: 3,
    backgroundColor: PALETTE.accentDim,
  },
  thumb: {
    position: "absolute",
    top: (36 - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: PALETTE.accent,
    borderWidth: 2,
    borderColor: PALETTE.bg,
  },
  edgeLabel: {
    color: PALETTE.textDim,
    fontSize: 12,
    fontWeight: "700",
    width: 14,
    textAlign: "center",
  },
});
