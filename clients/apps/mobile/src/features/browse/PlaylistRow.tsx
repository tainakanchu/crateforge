// プレイリスト一覧の 1 行。アイコン（フォルダ/スマート/通常）+ 名前 + 曲数。
// フォルダは親子の入れ子をアイコンで区別する（インデントは API がフラットなので最小限）。

import { Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type Playlist } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";

export interface PlaylistRowProps {
  playlist: Playlist;
  onPress?: () => void;
}

/** 種別ごとのアイコン名。 */
function iconFor(p: Playlist): keyof typeof Ionicons.glyphMap {
  if (p.isFolder) return "folder-outline";
  if (p.isSmart) return "sparkles-outline";
  return "musical-notes-outline";
}

export default function PlaylistRow({ playlist, onPress }: PlaylistRowProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={iconFor(playlist)} size={22} color={PALETTE.accent} />
      </View>
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>
          {playlist.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {playlist.isFolder ? "フォルダ" : playlist.isSmart ? "スマート" : "プレイリスト"}
          {/* フォルダは曲数を持たない（子を含む）ので曲数は出さない。 */}
          {playlist.isFolder ? null : ` ・ ${playlist.trackCount}曲`}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={PALETTE.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  pressed: {
    backgroundColor: PALETTE.surface,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: "center",
    justifyContent: "center",
  },
  texts: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: PALETTE.text,
    fontSize: 16,
    fontWeight: "700",
  },
  meta: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginTop: 2,
  },
});
