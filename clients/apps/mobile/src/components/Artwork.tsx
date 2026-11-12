// 曲のアートワーク。接続中は API の artwork を表示、未接続/欠損はプレースホルダ。
// ローカル保存済みアートがあればオフラインでも表示する。
// CRITICAL: アートワーク URL は track.trackId（iTunes trackId）で取得する。

import { StyleSheet } from "react-native";
import { Image } from "expo-image";

import { type Track, trackTitle, useConnection, useDownloads } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import ArtPlaceholder from "@/components/ArtPlaceholder";

export interface ArtworkProps {
  track: Track;
  size?: number;
  radius?: number;
}

export default function Artwork({ track, size = 48, radius = 6 }: ArtworkProps) {
  const client = useConnection((s) => s.client);
  // ローカル保存済みアートを最優先。DL完了で再描画されるようリアクティブに取得する。
  const localArtworkUri = useDownloads((s) => s.getLocalArtworkUri(track.trackId));
  const source = localArtworkUri ?? client?.artworkSource(track.trackId);
  const dimensions = { width: size, height: size, borderRadius: radius };

  if (!source) {
    return (
      <ArtPlaceholder
        name={track.album || trackTitle(track)}
        size={size}
        radius={radius}
      />
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
