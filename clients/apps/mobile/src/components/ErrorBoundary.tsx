// ルート用の軽量エラーバウンダリ。
// 描画中に例外が投げられた（= JS クラッシュ相当）ときに捕捉し、
// 再生エンジンを停止/解放して「音だけ鳴り続けるゾンビ再生」を防ぐ。
// その上で最小限のフォールバック UI を出す。
// 主因となる遷移時クラッシュ（#1）は別途修正済みで、これはあくまで保険。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

import { PALETTE, BRAND } from "@/constants/brand";
import { usePlayer } from "@crateforge/core";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 調査用ログ。
    console.error("[error-boundary]", error, info.componentStack);
    // 再生を止めて解放する。音だけ鳴り続ける事故を防ぐ（best-effort）。
    try {
      const engine = usePlayer.getState().engine;
      engine.pause();
      engine.release();
      usePlayer.setState({ isPlaying: false });
    } catch {
      // エンジン未差し込み等は無視（ここで二次例外を出さない）。
    }
  }

  private handleReset = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.root}>
          <Text style={styles.title}>問題が発生しました</Text>
          <Text style={styles.body}>
            画面の表示中にエラーが発生したため再生を停止しました。
          </Text>
          <Pressable
            onPress={this.handleReset}
            accessibilityRole="button"
            accessibilityLabel="再試行"
            style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
          >
            <Text style={styles.btnText}>再試行</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PALETTE.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: {
    color: PALETTE.text,
    fontSize: 18,
    fontWeight: "700",
  },
  body: {
    color: PALETTE.textDim,
    fontSize: 14,
    textAlign: "center",
  },
  btn: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.accent,
  },
  btnText: {
    color: BRAND.accentText,
    fontSize: 15,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.7,
  },
});
