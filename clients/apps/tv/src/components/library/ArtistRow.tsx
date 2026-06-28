// 共有のフォーカス可能なアーティスト行（10ft UI / D-pad 操作前提）。
// 円形アートワーク（代表トラックの artwork）+ アーティスト名 + 曲数 を 1 行で表示する。
// TrackRow と同じく Focusable を基盤にし、フォーカス時に scale 1.06 + teal リング + focusBg が付く。
//
// ## 使い方（artists 画面のマスターペインで使う）
// ```tsx
// <ArtistRow
//   artist={item}
//   active={selected === item.artist}     // 選択中をハイライト
//   hasTVPreferredFocus={i === 0}         // 画面表示時に最初の行へフォーカス
//   onFocus={() => setSelected(item.artist)}  // フォーカスで詳細ペインをプレビュー
//   onSelect={() => playAll(item.artist)}     // 決定でそのアーティストの全曲を再生
// />
// ```

import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";

import { type Artist, useConnection } from "@crateforge/core";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, FOCUS_RING } from "@/theme/palette";

export interface ArtistRowProps {
  /** 表示するアーティスト。 */
  artist: Artist;
  /** D-pad 決定 / タップ時のコールバック。 */
  onSelect?: () => void;
  /** フォーカス取得時のコールバック（詳細ペインのプレビュー切替などに使う）。 */
  onFocus?: () => void;
  /** 選択中などのアクティブ表示（名前を teal に + 背景強調）。 */
  active?: boolean;
  /** 画面内で最初にフォーカスを当てたい行に true。 */
  hasTVPreferredFocus?: boolean;
}

/** 共有のフォーカス可能なアーティスト行コンポーネント。 */
export function ArtistRow({ artist, onSelect, onFocus, active = false, hasTVPreferredFocus }: ArtistRowProps) {
  const client = useConnection((s) => s.client);

  return (
    <Focusable
      onSelect={onSelect}
      onFocus={onFocus}
      hasTVPreferredFocus={hasTVPreferredFocus}
      style={[styles.row, active && styles.rowActive]}
      accessibilityLabel={`${artist.artist}, ${artist.trackCount}曲`}
    >
      {client ? (
        <Image
          source={client.artworkSource(artist.sampleTrackId)}
          style={styles.artwork}
          contentFit="cover"
          recyclingKey={String(artist.sampleTrackId)}
        />
      ) : (
        <View style={[styles.artwork, styles.artworkPlaceholder]} />
      )}

      <View style={styles.texts}>
        <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
          {artist.artist}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {artist.trackCount}曲
        </Text>
      </View>
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
  artwork: {
    width: ARTWORK,
    height: ARTWORK,
    // 円形でアーティストらしさを出す。
    borderRadius: ARTWORK / 2,
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
  name: {
    fontSize: TV_FONT.sm,
    fontWeight: "600",
    color: PALETTE.text,
  },
  nameActive: {
    color: PALETTE.teal,
  },
  meta: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 4,
  },
});
