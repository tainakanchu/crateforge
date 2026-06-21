// ダウンロード品質のセグメント選択。原本 / AAC 256k / 192k / 128k を横並びで切り替える。
// useSettings.downloadQuality にバインドして使う（呼び出し側が value/onChange を渡す）。

import { Pressable, Text, View, StyleSheet } from "react-native";

import { type DownloadQuality } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";

/** 表示順とラベル（セグメント）。 */
const OPTIONS: { value: DownloadQuality; label: string }[] = [
  { value: "original", label: "原本" },
  { value: "aac256", label: "256k" },
  { value: "aac192", label: "192k" },
  { value: "aac128", label: "128k" },
];

export interface QualityPickerProps {
  value: DownloadQuality;
  onChange: (q: DownloadQuality) => void;
}

export default function QualityPicker({ value, onChange }: QualityPickerProps) {
  return (
    <View style={styles.group} accessibilityRole="radiogroup">
      {OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={opt.label}
            style={({ pressed }) => [
              styles.segment,
              active && styles.segmentActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: "row",
    backgroundColor: PALETTE.surfaceAlt,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    borderRadius: 8,
  },
  segmentActive: {
    backgroundColor: PALETTE.accent,
  },
  pressed: {
    opacity: 0.7,
  },
  segmentText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: BRAND.accentText,
    fontWeight: "700",
  },
});
