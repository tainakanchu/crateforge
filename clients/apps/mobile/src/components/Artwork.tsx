// 曲のアートワーク。接続中は API の artwork を表示、未接続/欠損はプレースホルダ。
// ローカル保存済みアートがあればオフラインでも表示する。
// プレースホルダは常に下に敷き、画像を上に重ねる（404 = アート無しでも頭文字が見える。LayeredArtwork）。
// CRITICAL: アートワーク URL は track.trackId（iTunes trackId）で取得する。

import { type Track, trackTitle, useConnection, useDownloads } from "@crateforge/core";
import LayeredArtwork from "@/components/LayeredArtwork";

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

  return (
    <LayeredArtwork
      source={source}
      name={track.album || trackTitle(track)}
      size={size}
      radius={radius}
      recyclingKey={String(track.trackId)}
    />
  );
}
