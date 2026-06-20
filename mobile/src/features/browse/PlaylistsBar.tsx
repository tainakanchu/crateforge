// プレイリストへの入口。横スクロールのカード列で、タップすると詳細へ遷移。
// フォルダ（isFolder）は曲を持たないので除外する。

import { Pressable, Text, ScrollView, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import type { Playlist } from "@/lib/types";
import { PALETTE } from "@/constants/brand";
import { usePlaylists } from "@/features/browse/hooks";

export interface PlaylistsBarProps {
  /** プレイリスト詳細へ遷移する。 */
  onOpen: (playlist: Playlist) => void;
}

export default function PlaylistsBar({ onOpen }: PlaylistsBarProps) {
  const { data } = usePlaylists();
  const playlists = (data ?? []).filter((p) => !p.isFolder);
  if (playlists.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>プレイリスト</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {playlists.map((p) => (
          <Pressable
            key={p.playlistId}
            onPress={() => onOpen(p)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          >
            <Ionicons
              name={p.isSmart ? "sparkles-outline" : "list-outline"}
              size={18}
              color={PALETTE.accent}
            />
            <Text style={styles.name} numberOfLines={2}>
              {p.name}
            </Text>
            <Text style={styles.count}>{p.trackCount}曲</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingTop: 4,
  },
  heading: {
    color: PALETTE.textDim,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  content: {
    paddingHorizontal: 16,
    gap: 10,
    paddingBottom: 4,
  },
  card: {
    width: 140,
    padding: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 6,
  },
  cardPressed: {
    backgroundColor: PALETTE.surfaceAlt,
  },
  name: {
    color: PALETTE.text,
    fontSize: 14,
    fontWeight: "600",
  },
  count: {
    color: PALETTE.textFaint,
    fontSize: 12,
  },
});
