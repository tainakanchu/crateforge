// クロスプラットフォームのボトムアクションシート。Alert.alert は Android でボタン 3 つまでなので、
// 多項目メニュー（曲メニュー・評価・並び順・タグ）はこれを使う。
// 命令的 API: showActionSheet({ title, actions }) を任意の場所（非フック）から呼べる。
// ルートに <ActionSheetHost /> を 1 つ置く。背景タップ / 戻るキー / キャンセルで閉じる。

import { useCallback } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";

import { PALETTE } from "@/constants/brand";

export interface ActionSheetAction {
  label: string;
  onPress?: () => void;
  destructive?: boolean;
  /** 現在選択中（✓ を付ける）。 */
  selected?: boolean;
  /** 補助テキスト（右側に薄く表示）。 */
  detail?: string;
}

export interface ActionSheetOptions {
  title?: string;
  subtitle?: string;
  actions: ActionSheetAction[];
  cancelLabel?: string;
}

interface SheetState {
  current: ActionSheetOptions | null;
  show: (o: ActionSheetOptions) => void;
  hide: () => void;
}

export const useActionSheet = create<SheetState>((set) => ({
  current: null,
  show: (o) => set({ current: o }),
  hide: () => set({ current: null }),
}));

/** アクションシートを開く。 */
export function showActionSheet(options: ActionSheetOptions): void {
  useActionSheet.getState().show(options);
}

export function ActionSheetHost() {
  const current = useActionSheet((s) => s.current);
  const hide = useActionSheet((s) => s.hide);
  return <ActionSheet options={current} onClose={hide} />;
}

export interface ActionSheetProps {
  options: ActionSheetOptions | null;
  onClose: () => void;
}

export default function ActionSheet({ options, onClose }: ActionSheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const run = useCallback(
    (a: ActionSheetAction) => {
      onClose();
      // シートを閉じてから実行（Alert など次の UI を出すアクションと競合させない）。
      if (a.onPress) setTimeout(a.onPress, 0);
    },
    [onClose],
  );

  return (
    <Modal
      visible={options != null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      supportedOrientations={["portrait", "landscape"]}
    >
      <View style={styles.root}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="メニューを閉じる"
        />
        {options ? (
          <View
            style={[
              styles.sheet,
              { paddingBottom: Math.max(insets.bottom, 12), maxHeight: height * 0.85 },
            ]}
            accessibilityViewIsModal
          >
            <View style={styles.grabber} />
            {options.title || options.subtitle ? (
              <View style={styles.header}>
                {options.title ? (
                  <Text style={styles.title} numberOfLines={1}>
                    {options.title}
                  </Text>
                ) : null}
                {options.subtitle ? (
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {options.subtitle}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <ScrollView style={styles.list} bounces={false} keyboardShouldPersistTaps="handled">
              {options.actions.map((a, i) => (
                <Pressable
                  key={`${i}-${a.label}`}
                  onPress={() => run(a)}
                  accessibilityRole="button"
                  accessibilityLabel={a.label}
                  accessibilityState={a.selected != null ? { selected: a.selected } : undefined}
                  style={({ pressed }) => [styles.item, pressed && styles.pressed]}
                >
                  <Text
                    style={[
                      styles.itemText,
                      a.destructive && styles.destructive,
                      a.selected && styles.selected,
                    ]}
                    numberOfLines={1}
                  >
                    {a.selected ? "✓ " : ""}
                    {a.label}
                  </Text>
                  {a.detail ? <Text style={styles.detail}>{a.detail}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={options.cancelLabel ?? "キャンセル"}
              style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
            >
              <Text style={styles.cancelText}>{options.cancelLabel ?? "キャンセル"}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    backgroundColor: PALETTE.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 8,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    ...(Platform.OS === "web" ? ({ boxShadow: "0 -4px 24px rgba(0,0,0,0.4)" } as object) : null),
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: PALETTE.border,
    marginBottom: 8,
  },
  header: {
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PALETTE.border,
  },
  title: { color: PALETTE.text, fontSize: 16, fontWeight: "700" },
  subtitle: { color: PALETTE.textDim, fontSize: 13, marginTop: 2 },
  list: { flexGrow: 0 },
  item: {
    minHeight: 48,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  pressed: { backgroundColor: PALETTE.surfaceAlt },
  itemText: { color: PALETTE.text, fontSize: 16, flexShrink: 1 },
  destructive: { color: PALETTE.danger },
  selected: { color: PALETTE.accent, fontWeight: "700" },
  detail: { color: PALETTE.textDim, fontSize: 13 },
  cancel: {
    marginTop: 8,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: PALETTE.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: PALETTE.accent, fontSize: 16, fontWeight: "700" },
});
