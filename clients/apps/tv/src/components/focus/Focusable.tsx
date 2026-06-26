// D-pad フォーカス可能な共通プリミティブ。
// Pressable をラップし、フォーカス時にスケール拡大(1.0→1.06)＋ボーダー表示を
// react-native-reanimated でアニメーションする。
// 後続の全 UI コンポーネント（SideNav 項目・リスト行・コントロールボタン等）はこれを基盤にする。

import { useState, useCallback } from "react";
import {
  Pressable,
  type PressableProps,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from "react-native-reanimated";

import { PALETTE, FOCUS_RING } from "@/theme/palette";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** フォーカス時のデフォルト視覚表現（テーマトークン経由）。 */
const DEFAULT_FOCUSED_STYLE: ViewStyle = {
  ...FOCUS_RING,
  backgroundColor: PALETTE.focusBg,
};

export interface FocusableProps {
  /** D-pad 決定キー / タップ時のコールバック。 */
  onSelect?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * このコンポーネントに優先的にフォーカスを当てるか。
   * 画面内で最初にフォーカスさせたい要素（例: サイドナビの先頭アイテム）に true を渡す。
   */
  hasTVPreferredFocus?: boolean;
  children: React.ReactNode;
  /** 通常時のスタイル。 */
  style?: StyleProp<ViewStyle>;
  /**
   * フォーカス時に適用するスタイル（省略時: FOCUS_RING + focusBg）。
   * 上書きする場合はボーダー・背景色を含めること。
   */
  focusedStyle?: ViewStyle;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * D-pad フォーカス可能な共通プリミティブ。
 *
 * ## 使い方（後続エージェント向け）
 * ```tsx
 * <Focusable
 *   onSelect={() => router.push("/songs")}
 *   style={styles.item}
 *   accessibilityLabel="曲一覧"
 * >
 *   <Text style={styles.label}>曲</Text>
 * </Focusable>
 * ```
 *
 * ## フォーカス優先度
 * 画面内で最初にフォーカスを当てたい要素には `hasTVPreferredFocus` を渡す。
 *
 * ## カスタムフォーカス外観
 * `focusedStyle` を渡すとデフォルトの teal ボーダー＋focusBg を上書きできる。
 */
export function Focusable({
  onSelect,
  onFocus,
  onBlur,
  hasTVPreferredFocus,
  children,
  style,
  focusedStyle,
  disabled,
  accessibilityLabel,
  testID,
}: FocusableProps) {
  const [isFocused, setIsFocused] = useState(false);
  const scale = useSharedValue(1);

  /** スケールアニメーション: フォーカス時に 1.06 へ、ブラー時に 1.0 へ戻す。 */
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    scale.value = withTiming(1.06, {
      duration: 120,
      easing: Easing.out(Easing.quad),
    });
    onFocus?.();
  }, [onFocus, scale]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    scale.value = withTiming(1.0, {
      duration: 100,
      easing: Easing.in(Easing.quad),
    });
    onBlur?.();
  }, [onBlur, scale]);

  const activeFocusedStyle = isFocused
    ? (focusedStyle ?? DEFAULT_FOCUSED_STYLE)
    : undefined;

  return (
    <AnimatedPressable
      // スケール + 通常スタイル + フォーカス時スタイルを合成
      style={[style, animStyle, activeFocusedStyle] as PressableProps["style"]}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onPress={onSelect}
      hasTVPreferredFocus={hasTVPreferredFocus}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      testID={testID}
    >
      {children}
    </AnimatedPressable>
  );
}
