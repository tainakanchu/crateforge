// MIDI 設定モーダル。接続中デバイスの一覧と、MIDI ラーンによる操作子の割り当てを行う。
// 「ラーン」をタップ → コントローラのフェーダー/ボタンを動かす → その操作子が割り当たる。
// 機種プリセットは持たず、DJM 系ミキサーも汎用コントローラもラーンで対応する。

import { FlatList, Modal, Pressable, Text, View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MidiDeviceDescriptor } from "expo-crateforge-midi";

import { PALETTE, BRAND } from "@/constants/brand";
import IconButton from "@/components/IconButton";

import { ALL_MIDI_TARGETS, targetLabel, useDjMidi, type MidiTarget } from "./midi";

export interface MidiPanelProps {
  visible: boolean;
  onClose: () => void;
  midiAvailable: boolean;
  devices: MidiDeviceDescriptor[];
}

export default function MidiPanel({ visible, onClose, midiAvailable, devices }: MidiPanelProps) {
  const insets = useSafeAreaInsets();
  const mapping = useDjMidi((s) => s.mapping);
  const learnTarget = useDjMidi((s) => s.learnTarget);
  const setLearnTarget = useDjMidi((s) => s.setLearnTarget);
  const clearBinding = useDjMidi((s) => s.clearBinding);
  const clearAll = useDjMidi((s) => s.clearAll);

  const close = () => {
    // ラーン待ちのまま閉じない（次のセッションで誤学習しないように）。
    setLearnTarget(null);
    onClose();
  };

  const inputDevices = devices.filter((d) => d.outputPorts > 0);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>MIDI コントローラ</Text>
          <IconButton name="close" onPress={close} accessibilityLabel="閉じる" />
        </View>

        <FlatList
          data={ALL_MIDI_TARGETS}
          keyExtractor={(t) => t}
          ListHeaderComponent={
            <View style={styles.section}>
              {!midiAvailable ? (
                <Text style={styles.note}>
                  この環境では MIDI 入力を使えません（Android 実機 + USB OTG 接続で利用できます）。
                </Text>
              ) : inputDevices.length === 0 ? (
                <Text style={styles.note}>
                  MIDI デバイスが見つかりません。USB (OTG) でコントローラやミキサー
                  （DJM シリーズ等）を接続してください。
                </Text>
              ) : (
                <>
                  <Text style={styles.sectionTitle}>接続中のデバイス</Text>
                  {inputDevices.map((d) => (
                    <View key={d.id} style={styles.deviceRow}>
                      <Text style={styles.deviceName} numberOfLines={1}>
                        {d.name}
                      </Text>
                      <Text style={styles.devicePorts}>ports: {d.outputPorts}</Text>
                    </View>
                  ))}
                </>
              )}
              <Text style={styles.sectionTitle}>割り当て（MIDI ラーン）</Text>
              <Text style={styles.note}>
                「ラーン」を押してから、コントローラの割り当てたいフェーダー/ボタンを
                動かすと記憶されます。
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <MappingRow
              target={item}
              binding={mapping[item] ?? null}
              learning={learnTarget === item}
              onLearn={() => setLearnTarget(learnTarget === item ? null : item)}
              onClear={() => clearBinding(item)}
            />
          )}
          ListFooterComponent={
            <Pressable
              onPress={clearAll}
              accessibilityRole="button"
              style={({ pressed }) => [styles.clearAllBtn, pressed && styles.pressed]}
            >
              <Text style={styles.clearAllText}>すべての割り当てをクリア</Text>
            </Pressable>
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        />
      </View>
    </Modal>
  );
}

function MappingRow({
  target,
  binding,
  learning,
  onLearn,
  onClear,
}: {
  target: MidiTarget;
  binding: string | null;
  learning: boolean;
  onLearn: () => void;
  onClear: () => void;
}) {
  return (
    <View style={styles.mappingRow}>
      <Text style={styles.mappingLabel} numberOfLines={1}>
        {targetLabel(target)}
      </Text>
      <Text style={[styles.bindingText, binding == null && styles.bindingNone]} numberOfLines={1}>
        {binding ?? "未割当"}
      </Text>
      <Pressable
        onPress={onLearn}
        accessibilityRole="button"
        accessibilityLabel={`${targetLabel(target)} をラーン`}
        style={({ pressed }) => [
          styles.learnBtn,
          learning && styles.learnBtnActive,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.learnBtnText, learning && styles.learnBtnTextActive]}>
          {learning ? "待機中…" : "ラーン"}
        </Text>
      </Pressable>
      <IconButton
        name="close-circle-outline"
        onPress={onClear}
        size={18}
        color={binding == null ? PALETTE.textFaint : PALETTE.textDim}
        disabled={binding == null}
        accessibilityLabel={`${targetLabel(target)} の割り当てを解除`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerTitle: {
    color: PALETTE.text,
    fontSize: 16,
    fontWeight: "700",
  },
  section: {
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 4,
  },
  sectionTitle: {
    color: PALETTE.text,
    fontSize: 14,
    fontWeight: "700",
    marginTop: 10,
  },
  note: {
    color: PALETTE.textDim,
    fontSize: 12,
    lineHeight: 18,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: PALETTE.surface,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  deviceName: {
    color: PALETTE.text,
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  devicePorts: {
    color: PALETTE.textFaint,
    fontSize: 11,
  },
  mappingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  mappingLabel: {
    color: PALETTE.text,
    fontSize: 13,
    flex: 1,
  },
  bindingText: {
    color: BRAND.accent,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    maxWidth: 90,
  },
  bindingNone: {
    color: PALETTE.textFaint,
  },
  learnBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: PALETTE.surfaceAlt,
  },
  learnBtnActive: {
    backgroundColor: BRAND.accent,
  },
  learnBtnText: {
    color: PALETTE.text,
    fontSize: 12,
    fontWeight: "700",
  },
  learnBtnTextActive: {
    color: BRAND.accentText,
  },
  clearAllBtn: {
    marginTop: 16,
    marginHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    backgroundColor: PALETTE.surface,
  },
  clearAllText: {
    color: PALETTE.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.7,
  },
});
