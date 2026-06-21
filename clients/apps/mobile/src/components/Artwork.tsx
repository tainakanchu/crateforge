// 曲のアートワーク。接続中は API の artwork を表示、未接続/欠損はプレースホルダ。
// CRITICAL: アートワーク URL は track.trackId（iTunes trackId）で取得する。

import { View, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

import { type Track, useConnection } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";

export interface ArtworkProps {
  track: Track;
  size?: number;
  radius?: number;
}

export default function Artwork({ track, size = 48, radius = 6 }: ArtworkProps) {
  const client = useConnection((s) => s.client);
  const source = client?.artworkSource(track.trackId);
  const dimensions = { width: size, height: size, borderRadius: radius };

  if (!source) {
    return (
      <View style={[styles.placeholder, dimensions]}>
        <Ionicons name="musical-note" size={Math.round(size * 0.5)} color={PALETTE.textFaint} />
      </View>
    );
  }

  return (
    <Image
      source={source}
      style={[styles.image, dimensions]}
      contentFit="cover"
      transition={120}
      recyclingKey={String(track.trackId)}
    />
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: PALETTE.surfaceAlt,
  },
  placeholder: {
    backgroundColor: PALETTE.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
});
