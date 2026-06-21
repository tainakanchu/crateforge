// 曲一覧の 1 行。アートワーク + タイトル/サブタイトル + 任意の trailing。
// active=true で再生中などをアクセント表示する。
// rowMetaFields（Settings 設定）が有効なフィールドの値を小さく 3 行目に表示する。

import type { ReactNode } from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";

import { type Track, trackTitle, trackSubtitle, trackMetaText, useSettings } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import Artwork from "@/components/Artwork";

export interface TrackRowProps {
  track: Track;
  onPress?: () => void;
  onLongPress?: () => void;
  trailing?: ReactNode;
  active?: boolean;
  /** 行頭に出す番号（1 始まりにしたい場合は呼び出し側で +1 する）。 */
  index?: number;
}

export default function TrackRow({
  track,
  onPress,
  onLongPress,
  trailing,
  active = false,
  index,
}: TrackRowProps) {
  const fields = useSettings((s) => s.rowMetaFields);
  const metaParts = fields
    .map((f) => trackMetaText(track, f))
    .filter((v): v is string => v !== null);
  const metaLine = metaParts.length > 0 ? metaParts.join(" · ") : null;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        active && styles.active,
        pressed && styles.pressed,
      ]}
    >
      {index != null ? (
        <Text style={styles.index} numberOfLines={1}>
          {index}
        </Text>
      ) : null}
      <Artwork track={track} size={44} radius={5} />
      <View style={styles.texts}>
        <Text
          style={[styles.title, active && styles.activeText]}
          numberOfLines={1}
        >
          {trackTitle(track)}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {trackSubtitle(track)}
        </Text>
        {metaLine != null ? (
          <Text style={styles.meta} numberOfLines={1}>
            {metaLine}
          </Text>
        ) : null}
      </View>
      {trailing != null ? <View style={styles.trailing}>{trailing}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  active: {
    backgroundColor: PALETTE.surfaceAlt,
  },
  pressed: {
    backgroundColor: PALETTE.surface,
  },
  index: {
    width: 24,
    textAlign: "center",
    color: PALETTE.textFaint,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  texts: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: PALETTE.text,
    fontSize: 15,
    fontWeight: "600",
  },
  activeText: {
    color: PALETTE.accent,
  },
  subtitle: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  meta: {
    color: PALETTE.textFaint,
    fontSize: 11,
    marginTop: 2,
  },
  trailing: {
    flexShrink: 0,
  },
});
