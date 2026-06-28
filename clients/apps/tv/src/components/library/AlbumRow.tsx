// 共有のフォーカス可能なアルバム行（10ft UI / D-pad 操作前提）。
// 代表トラックのアートワーク(やや大きめ) + アルバム名(太字) + アルバムアーティスト ・ 曲数 を 1 行で表示する。
// TrackRow と同じく Focusable を基盤にしているため、フォーカス時に scale 1.06 + teal リング + focusBg が付く。
// アートワークは album.sampleTrackId（= 代表トラックの trackId）で取得する。
//
// ## 利用側（albums.tsx のアルバム一覧）
// ```tsx
// <AlbumRow
//   album={item}
//   hasTVPreferredFocus={index === 0}  // 画面表示時に最初の行へフォーカス
//   onSelect={() => openAlbum(item)}   // 詳細（曲一覧）へ
//   onFocus={() => scrollTo(index)}    // 任意: フォーカス時に呼ばれる
// />
// ```

import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";

import { type Album, useConnection } from "@crateforge/core";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, FOCUS_RING } from "@/theme/palette";

export interface AlbumRowProps {
  /** 表示するアルバム。 */
  album: Album;
  /** D-pad 決定 / タップ時のコールバック。 */
  onSelect?: () => void;
  /** フォーカス取得時のコールバック（リストのスクロール追従などに使える）。 */
  onFocus?: () => void;
  /** 画面内で最初にフォーカスを当てたい行に true。 */
  hasTVPreferredFocus?: boolean;
}

/** 共有のフォーカス可能なアルバム行コンポーネント。 */
export function AlbumRow({ album, onSelect, onFocus, hasTVPreferredFocus }: AlbumRowProps) {
  const client = useConnection((s) => s.client);
  // 空のアルバム名は「アルバムなし」として表示する（distinct 集計で空キーが来る場合がある）。
  const name = album.album || "アルバムなし";
  const meta = `${album.albumArtist ? `${album.albumArtist} ・ ` : ""}${album.trackCount}曲`;

  return (
    <Focusable
      onSelect={onSelect}
      onFocus={onFocus}
      hasTVPreferredFocus={hasTVPreferredFocus}
      style={styles.row}
      accessibilityLabel={`${name}, ${meta}`}
    >
      {client ? (
        <Image
          source={client.artworkSource(album.sampleTrackId)}
          style={styles.artwork}
          contentFit="cover"
        />
      ) : (
        <View style={[styles.artwork, styles.artworkPlaceholder]} />
      )}

      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
    </Focusable>
  );
}

const ARTWORK = 80;

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
  name: {
    fontSize: TV_FONT.md,
    fontWeight: "700",
    color: PALETTE.text,
  },
  meta: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 4,
  },
});
