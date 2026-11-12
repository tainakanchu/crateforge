// アルバム一覧の 1 行。サムネイル（代表トラックの artwork）+ アルバム名（太字）
// + アルバムアーティスト + 曲数。未接続/欠損はプレースホルダ。
// ローカル保存済みアートがあればオフラインでも表示する。
// CRITICAL: artwork は album.sampleTrackId（= trackId）で取得する。

import { Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type Album, useConnection, useDownloads } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import LayeredArtwork from "@/components/LayeredArtwork";

export interface AlbumRowProps {
  album: Album;
  onPress?: () => void;
}

const THUMB = 48;
const RADIUS = 6;

export default function AlbumRow({ album, onPress }: AlbumRowProps) {
  const client = useConnection((s) => s.client);
  // ローカル保存済みアートを最優先。DL完了で再描画されるようリアクティブに取得する。
  const localArtworkUri = useDownloads((s) => s.getLocalArtworkUri(album.sampleTrackId));
  const source = localArtworkUri ?? client?.artworkSource(album.sampleTrackId);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {/* 頭文字プレースホルダを下に敷き画像を重ねる（404 でも空箱にしない）。 */}
      <LayeredArtwork
        source={source}
        name={album.album}
        size={THUMB}
        radius={RADIUS}
        recyclingKey={String(album.sampleTrackId)}
      />
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>
          {album.album || "アルバムなし"}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {album.albumArtist ? `${album.albumArtist} ・ ` : ""}
          {album.trackCount}曲
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
