// アートワーク画像 + 頭文字プレースホルダの重ね表示（TV 共通）。
// 曲行 / アルバム行 / アーティスト行 / ミニプレイヤー / Now Playing の 5 箇所で使う。
//
// プレースホルダ（名前の頭文字 + 名前から決まる色。core の artPlaceholder）を常に下に敷き、
// 画像はその上に絶対配置で重ねる。接続中は artwork URL が常にあるため、404（アート無し）や
// 読み込み失敗でも空の箱ではなく頭文字が見える。未接続時はプレースホルダのみ。
// 画像側には背景色を付けない（付けると読み込み失敗時にプレースホルダを覆ってしまう）。
// CRITICAL: アートワーク URL は trackId（iTunes trackId）で取得する。

import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { Image } from "expo-image";

import { placeholderColor, placeholderInitial, useConnection } from "@crateforge/core";

export interface ArtworkProps {
  /** アートワークを引く曲の trackId（アルバム / アーティストは代表トラック）。 */
  trackId: number;
  /** 頭文字と色の元になる名前（アルバム名・アーティスト名・曲名など）。 */
  name: string | null | undefined;
  /** 一辺の長さ（px）。 */
  size: number;
  /** 角丸（円形にするなら size / 2）。 */
  radius: number;
  /** 外枠への追加スタイル（余白など）。 */
  style?: StyleProp<ViewStyle>;
}

export function Artwork({ trackId, name, size, radius, style }: ArtworkProps) {
  const client = useConnection((s) => s.client);
  const source = client ? client.artworkSource(trackId) : null;
  const key = source ? source.uri : "";
  // 失敗した URI を覚える（曲が変われば key が変わり、自動的に再試行される）。
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const showImage = source != null && failedKey !== key;
  const box = { width: size, height: size, borderRadius: radius };

  return (
    <View
      style={[styles.box, box, { backgroundColor: placeholderColor(name) }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.letter, { fontSize: Math.round(size * 0.42) }]}>
        {placeholderInitial(name)}
      </Text>
      {showImage ? (
        <Image
          testID="artwork-image"
          source={source}
          style={[StyleSheet.absoluteFill, box]}
          contentFit="cover"
          recyclingKey={String(trackId)}
          onError={() => setFailedKey(key)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
  },
  letter: {
    color: "rgba(255,255,255,0.85)",
    fontWeight: "700",
  },
});
