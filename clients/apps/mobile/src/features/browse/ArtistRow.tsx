// アーティスト一覧の 1 行。サムネイル（代表トラックの artwork）+ アーティスト名（太字）+ 曲数。
// ローカル保存済みアートがあればオフラインでも表示する。
// CRITICAL: artwork は artist.sampleTrackId（= trackId）で取得する。

import { Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type Artist, useConnection, useDownloads } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import LayeredArtwork from "@/components/LayeredArtwork";

export interface ArtistRowProps {
  artist: Artist;
  onPress?: () => void;
}

const THUMB = 48;
const RADIUS = 24; // 円形でアーティスト感を出す

export default function ArtistRow({ artist, onPress }: ArtistRowProps) {
  const client = useConnection((s) => s.client);
  // ローカル保存済みアートを最優先。DL完了で再描画されるようリアクティブに取得する。
  const localArtworkUri = useDownloads((s) => s.getLocalArtworkUri(artist.sampleTrackId));
  const source = localArtworkUri ?? client?.artworkSource(artist.sampleTrackId);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {/* 頭文字プレースホルダを下に敷き画像を重ねる（404 でも空箱にしない）。 */}
      <LayeredArtwork
        source={source}
        name={artist.artist}
        size={THUMB}
        radius={RADIUS}
        recyclingKey={String(artist.sampleTrackId)}
      />
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
