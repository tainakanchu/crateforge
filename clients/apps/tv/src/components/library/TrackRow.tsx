// 共有のフォーカス可能な曲リスト行（10ft UI / D-pad 操作前提）。
// アートワーク(小) + タイトル + サブタイトル(Artist — Album) を 1 行で表示する。
// Focusable を基盤にしているため、フォーカス時に scale 1.06 + teal リング + focusBg が付く。
//
// ## 後続エージェント向け（albums/artists/playlists/search から再利用する）
// ```tsx
// <TrackRow
//   track={item}
//   index={i + 1}                       // 任意: 行頭の番号（省略可）
//   active={currentTrackId === item.trackId}  // 再生中をハイライト
//   hasTVPreferredFocus={i === 0}       // 画面表示時に最初の行へフォーカス
//   subtitle="Artist のみ"               // 任意: サブタイトル文言を上書き
//   trailing={<SomeBadge />}            // 任意: 行末の要素
//   onSelect={() => play(i)}
//   onFocus={() => scrollTo(i)}         // 任意: フォーカス時に呼ばれる
// />
// ```

import type { ReactNode } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";

import { type Track, useConnection, trackTitle, trackSubtitle } from "@crateforge/core";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, FOCUS_RING } from "@/theme/palette";

export interface TrackRowProps {
  /** 表示する曲。 */
  track: Track;
  /** D-pad 決定 / タップ時のコールバック。 */
  onSelect?: () => void;
  /** フォーカス取得時のコールバック（リストのスクロール追従などに使える）。 */
  onFocus?: () => void;
  /** 再生中などのアクティブ表示（タイトルを teal に）。 */
  active?: boolean;
  /** 行頭に出す番号（1 始まりにしたい場合は呼び出し側で +1 する）。省略時は非表示。 */
  index?: number;
  /** 行末に出す任意の要素（ダウンロード状態・尺など）。 */
  trailing?: ReactNode;
  /** サブタイトル文言の上書き（省略時は "Artist — Album"）。 */
  subtitle?: string;
  /** 画面内で最初にフォーカスを当てたい行に true。 */
  hasTVPreferredFocus?: boolean;
}

/** 共有のフォーカス可能な曲行コンポーネント。 */
export function TrackRow({
  track,
  onSelect,
  onFocus,
  active = false,
  index,
  trailing,
  subtitle,
  hasTVPreferredFocus,
}: TrackRowProps) {
  const client = useConnection((s) => s.client);
  const sub = subtitle ?? trackSubtitle(track);

  return (
    <Focusable
      onSelect={onSelect}
      onFocus={onFocus}
      hasTVPreferredFocus={hasTVPreferredFocus}
      style={[styles.row, active && styles.rowActive]}
      accessibilityLabel={`${trackTitle(track)}, ${sub}`}
    >
      {index != null ? (
        <Text style={styles.index} numberOfLines={1}>
          {index}
        </Text>
      ) : null}

      {client ? (
        <Image
          source={client.artworkSource(track.trackId)}
          style={styles.artwork}
          contentFit="cover"
        />
      ) : (
        <View style={[styles.artwork, styles.artworkPlaceholder]} />
      )}

      <View style={styles.texts}>
        <Text style={[styles.title, active && styles.titleActive]} numberOfLines={1}>
          {trackTitle(track)}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {sub}
        </Text>
      </View>

      {trailing != null ? <View style={styles.trailing}>{trailing}</View> : null}
    </Focusable>
  );
}

const ARTWORK = 64;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginVertical: 2,
    // フォーカス時に default focusedStyle(FOCUS_RING) が borderColor を teal に
    // 差し替えても行がガタつかないよう、同じ太さの透明ボーダーを基底に持たせる。
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
    borderRadius: FOCUS_RING.borderRadius,
  },
  rowActive: {
    backgroundColor: PALETTE.surface,
  },
  index: {
    minWidth: 40,
    textAlign: "center",
    color: PALETTE.textSub,
    fontSize: TV_FONT.xs,
    fontVariant: ["tabular-nums"],
  },
  artwork: {
    width: ARTWORK,
    height: ARTWORK,
    borderRadius: 6,
    backgroundColor: PALETTE.surface,
    flexShrink: 0,
  },
  artworkPlaceholder: {
    backgroundColor: PALETTE.surface,
  },
  texts: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: TV_FONT.sm,
    fontWeight: "600",
    color: PALETTE.text,
  },
  titleActive: {
    color: PALETTE.teal,
  },
  subtitle: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 4,
  },
  trailing: {
    flexShrink: 0,
  },
});
