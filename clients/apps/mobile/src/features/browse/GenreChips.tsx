// ジャンル絞り込みの横スクロールチップ。タップで選択トグル。
// 選択中は client 側で genre 部分一致クエリに使う tag をそのまま渡す。

import { Pressable, Text, ScrollView, StyleSheet } from "react-native";

import { type GenreTagCount } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";

export interface GenreChipsProps {
  genres: GenreTagCount[];
  /** 選択中ジャンル（tag）。未選択は null。 */
  selected: string | null;
  /** トグル。同じ tag を再タップで null に戻すのは呼び出し側で判断。 */
  onSelect: (tag: string | null) => void;
}

export default function GenreChips({ genres, selected, onSelect }: GenreChipsProps) {
  if (genres.length === 0) return null;
  return (
    <ScrollView
      testID="genre-chips"
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      style={styles.scroll}
    >
      {genres.map((g) => {
        const active = selected === g.tag;
        return (
          <Pressable
            key={g.tag}
            onPress={() => onSelect(active ? null : g.tag)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressed && styles.chipPressed,
            ]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
              {g.tag}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // 縦方向の親（Screen の column）で潰されないよう、ScrollView 自体を縮ませない。
  // react-native-web の ScrollView は既定で flexShrink:1 のため、長い一覧と並ぶと高さ 0 近くまで潰れる（round-2 M3）。
  scroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  chip: {
    flexShrink: 0,
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  chipActive: {
    backgroundColor: PALETTE.accent,
    borderColor: PALETTE.accent,
  },
  chipPressed: {
    opacity: 0.7,
  },
  chipText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  chipTextActive: {
    color: BRAND.accentText,
  },
});
