// 軽量トースト（全プラットフォーム共通・非ブロッキング）。
// 命令的 API: showToast("メッセージ")。ルートに <ToastHost /> を 1 つ置く。

import { useEffect } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";

import { PALETTE } from "@/constants/brand";

interface ToastState {
  message: string | null;
  seq: number;
  kind: "info" | "error";
  show: (message: string, kind?: "info" | "error") => void;
  clear: () => void;
}

export const useToast = create<ToastState>((set, get) => ({
  message: null,
  seq: 0,
  kind: "info",
  show: (message, kind = "info") => set({ message, kind, seq: get().seq + 1 }),
  clear: () => set({ message: null }),
}));

export function showToast(message: string, kind: "info" | "error" = "info"): void {
  useToast.getState().show(message, kind);
}

const DURATION_MS = 3500;
// ミニプレイヤー + タブバーの上に出す（重ならないよう余白を取る）。
const BOTTOM_OFFSET = 150;

export function ToastHost() {
  const message = useToast((s) => s.message);
  const seq = useToast((s) => s.seq);
  const kind = useToast((s) => s.kind);
  const clear = useToast((s) => s.clear);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(clear, DURATION_MS);
    return () => clearTimeout(t);
  }, [message, seq, clear]);

  if (!message) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.wrap, { bottom: BOTTOM_OFFSET + insets.bottom }]}
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.toast, kind === "error" && styles.error]}>
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    alignItems: "center",
    zIndex: 1000,
  },
  toast: {
    maxWidth: 520,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surfaceAlt,
    borderWidth: 1,
    borderColor: PALETTE.border,
    ...(Platform.OS === "web" ? ({ boxShadow: "0 4px 16px rgba(0,0,0,0.4)" } as object) : null),
  },
  error: { borderColor: PALETTE.danger },
  text: { color: PALETTE.text, fontSize: 14, lineHeight: 20 },
});
