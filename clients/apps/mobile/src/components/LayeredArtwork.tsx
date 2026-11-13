// アートワーク画像 + 頭文字プレースホルダの重ね表示。
// プレースホルダを常に下に敷き、画像はその上に絶対配置で重ねる。
// 接続中は artwork URL が常にあるため、404（アート無し）や読み込み失敗でも
// 空の箱ではなく頭文字プレースホルダが見えるようにする（round-2 M4）。
// 画像側には背景色を付けない（付けると読み込み失敗時にプレースホルダを覆ってしまう）。
// onError では画像自体を外す（web で壊れ画像アイコンが出るのも防ぐ）。

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";

import ArtPlaceholder from "@/components/ArtPlaceholder";

export interface LayeredArtworkProps {
  /** 画像ソース（null/undefined ならプレースホルダのみ）。 */
  source: { uri: string; headers?: Record<string, string> } | string | null | undefined;
  /** 頭文字と色の元になる名前。 */
  name: string | null | undefined;
  size: number;
  radius: number;
  /** expo-image の recyclingKey（リスト内の再利用で前の画像が残らないように）。 */
  recyclingKey?: string;
}

function sourceKey(source: LayeredArtworkProps["source"]): string {
  if (!source) return "";
  return typeof source === "string" ? source : source.uri;
}

export default function LayeredArtwork({ source, name, size, radius, recyclingKey }: LayeredArtworkProps) {
  const key = sourceKey(source);
  // 失敗した URI を覚える（source が変われば failedKey と一致しなくなり自動的に再試行される）。
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const showImage = !!source && failedKey !== key;
  const box = { width: size, height: size, borderRadius: radius };

  return (
    <View style={[styles.box, box]}>
      <ArtPlaceholder name={name} size={size} radius={radius} />
      {showImage ? (
        <Image
          testID="artwork-image"
          source={source}
          style={[StyleSheet.absoluteFill, box]}
          contentFit="cover"
          transition={120}
          recyclingKey={recyclingKey}
          onError={() => setFailedKey(key)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    overflow: "hidden",
  },
});
