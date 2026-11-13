// ドラッグ/タップで 0–1 の値を決める横バー（シーク・音量で共用）。追加依存なし。
// RN の responder システムを直接使う（タップ = 押下位置、ドラッグ = 押下位置 + pageX の移動量）。
// ドラッグ中は手元の値を表示し、離したときだけ onCommit する（毎フレーム API を叩かない）。
// タッチ領域は高さ 44pt。

import { useEffect, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import type { GestureResponderEvent, LayoutChangeEvent } from "react-native";

import { PALETTE } from "@/constants/brand";

export interface DragBarProps {
  /** 現在値 0–1（ホストから報告された値）。 */
  value: number;
  /** 離した/タップした位置の値 0–1。 */
  onCommit: (value: number) => void;
  /** ドラッグ中の値（0–1）を通知する。離した/キャンセルで null。 */
  onDragChange?: (value: number | null) => void;
  disabled?: boolean;
  accessibilityLabel: string;
  /** 読み上げ用の値テキスト（例: "30%"）。 */
  accessibilityValueText?: string;
  /** a11y の増減アクションの刻み（0–1）。 */
  step?: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export default function DragBar({
  value,
  onCommit,
  onDragChange,
  disabled = false,
  accessibilityLabel,
  accessibilityValueText,
  step = 0.05,
}: DragBarProps) {
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  // 離した直後、ホストの値が追いつくまで離した位置を表示し続ける。
  // base = 離した時点の value。value が変わったら（ホストが追いついたら）無効になる。
  const [pendingState, setPending] = useState<{ ratio: number; base: number } | null>(null);
  const pending = pendingState && pendingState.base === value ? pendingState.ratio : null;
  const start = useRef({ x: 0, page: 0 });

  useEffect(() => {
    if (pendingState == null) return;
    const t = setTimeout(() => setPending(null), 1500);
    return () => clearTimeout(t);
  }, [pendingState]);

  const shown = clamp01(drag ?? pending ?? value);

  const ratioAt = (e: GestureResponderEvent): number => {
    if (width <= 0) return 0;
    const { pageX } = e.nativeEvent;
    return clamp01((start.current.x + (pageX - start.current.page)) / width);
  };

  const commit = (r: number) => {
    setPending({ ratio: r, base: value });
    onCommit(r);
  };

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100), text: accessibilityValueText }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        if (disabled) return;
        if (e.nativeEvent.actionName === "increment") commit(clamp01(shown + step));
        else if (e.nativeEvent.actionName === "decrement") commit(clamp01(shown - step));
      }}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        start.current = { x: e.nativeEvent.locationX, page: e.nativeEvent.pageX };
        const r = ratioAt(e);
        setDrag(r);
        onDragChange?.(r);
      }}
      onResponderMove={(e) => {
        const r = ratioAt(e);
        setDrag(r);
        onDragChange?.(r);
      }}
      onResponderRelease={(e) => {
        const r = ratioAt(e);
        setDrag(null);
        onDragChange?.(null);
        if (width > 0) commit(r);
      }}
      onResponderTerminate={() => {
        setDrag(null);
        onDragChange?.(null);
      }}
      style={styles.hit}
    >
      <View style={styles.trackBg} pointerEvents="none" />
      <View style={[styles.fill, { width: `${shown * 100}%` }]} pointerEvents="none" />
      <View style={[styles.thumb, { left: `${shown * 100}%` }]} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: {
    height: 44,
    justifyContent: "center",
  },
  trackBg: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: PALETTE.surfaceAlt,
  },
  fill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: PALETTE.accent,
  },
  thumb: {
    position: "absolute",
    width: 14,
    height: 14,
    marginLeft: -7,
    borderRadius: 7,
    backgroundColor: PALETTE.accent,
  },
});
