// 共有の縦リスト枠。ローディング / エラー / 空 の 3 状態を中央表示で吸収し、
// データがあるときだけ FlatList を描画する。TrackRow など任意の行と組み合わせて使う。
//
// ## 後続エージェント向け（artists/playlists/search の縦リストで再利用する）
// ```tsx
// <LibraryList
//   data={tracks}
//   keyExtractor={(t) => String(t.trackId)}
//   isLoading={query.isLoading}
//   isError={query.isError}
//   errorMessage="読み込みに失敗しました"
//   emptyMessage="曲がありません"
//   renderItem={({ item, index }) => (
//     <TrackRow track={item} hasTVPreferredFocus={index === 0} onSelect={() => play(index)} />
//   )}
// />
// ```
// グリッド表示が欲しい画面（albums 等）は numColumns を渡すか、独自に FlatList を組んでよい。

import type { ReactElement } from "react";
import {
  ActivityIndicator,
  FlatList,
  Text,
  View,
  StyleSheet,
  type ListRenderItem,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { PALETTE, TV_FONT, TV_LAYOUT } from "@/theme/palette";

export interface LibraryListProps<T> {
  /** 表示するデータ。 */
  data: T[];
  /** 各行のレンダラ。 */
  renderItem: ListRenderItem<T>;
  /** キー抽出。 */
  keyExtractor: (item: T, index: number) => string;
  /** 取得中フラグ（データ未到着のときだけスピナーを出す）。 */
  isLoading?: boolean;
  /** エラーフラグ（データ未到着のときだけエラー文言を出す）。 */
  isError?: boolean;
  /** エラー時の文言（省略時は汎用文）。 */
  errorMessage?: string;
  /** 空のときの文言（省略時は汎用文）。 */
  emptyMessage?: string;
  /** グリッド列数（省略時は 1 列の縦リスト）。 */
  numColumns?: number;
  /** リスト先頭に差し込む要素。 */
  ListHeaderComponent?: ReactElement | null;
  /** FlatList の contentContainerStyle を追記したい場合。 */
  contentContainerStyle?: StyleProp<ViewStyle>;
}

/** ローディング/エラー/空を吸収する共有リスト枠。 */
export function LibraryList<T>({
  data,
  renderItem,
  keyExtractor,
  isLoading = false,
  isError = false,
  errorMessage = "読み込みに失敗しました",
  emptyMessage = "項目がありません",
  numColumns,
  ListHeaderComponent,
  contentContainerStyle,
}: LibraryListProps<T>) {
  // データ未到着のときだけ状態表示にする（再取得中の点滅を避け、既存データは出し続ける）。
  if (data.length === 0) {
    if (isLoading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PALETTE.teal} />
        </View>
      );
    }
    return (
      <View style={styles.center}>
        <Text style={styles.stateText}>{isError ? errorMessage : emptyMessage}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      numColumns={numColumns}
      ListHeaderComponent={ListHeaderComponent}
      contentContainerStyle={[styles.content, contentContainerStyle]}
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  stateText: {
    fontSize: TV_FONT.md,
    color: PALETTE.textSub,
  },
  content: {
    paddingBottom: TV_LAYOUT.contentPaddingV,
  },
});
