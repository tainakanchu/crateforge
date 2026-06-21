// アーティスト一覧の 1 行。サムネイル（代表トラックの artwork）+ アーティスト名（太字）+ 曲数。
// CRITICAL: artwork は artist.sampleTrackId（= trackId）で取得する。

import { Pressable, Text, View, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

import { type Artist, useConnection } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";

export interface ArtistRowProps {
  artist: Artist;
  onPress?: () => void;
}

const THUMB = 48;
const RADIUS = 24; // 円形でアーティスト感を出す

export default function ArtistRow({ artist, onPress }: ArtistRowProps) {
  const client = useConnection((s) => s.client);
  const source = client?.artworkSource(artist.sampleTrackId);
  const dimensions = { width: THUMB, height: THUMB, borderRadius: RADIUS };

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {source ? (
        <Image
          source={source}
          style={[styles.image, dimensions]}
          contentFit="cover"
          transition={120}
          recyclingKey={String(artist.sampleTrackId)}
        />
      ) : (
        <View style={[styles.placeholder, dimensions]}>
          <Ionicons name="person-outline" size={Math.round(THUMB * 0.5)} color={PALETTE.textFaint} />
        </View>
      )}
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>
          {artist.artist}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {artist.trackCount}曲
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
    paddingVertical: 8,
    gap: 12,
  },
  pressed: {
    backgroundColor: PALETTE.surface,
  },
  image: {
    backgroundColor: PALETTE.surfaceAlt,
  },
  placeholder: {
    backgroundColor: PALETTE.surfaceAlt,
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
