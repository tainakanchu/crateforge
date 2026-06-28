// 検索画面。リモコンで TextInput にフォーカス→決定でシステムのオンスクリーンキーボードが開く
// （Android TV の Gboard / tvOS の IME）。入力語をデバウンスして core の ApiClient.listTracks
// に q として渡し、ヒットした曲を共有 TrackRow + LibraryList で一覧表示する。
// 行を選ぶと usePlayer.setQueue で検索結果をキューに差し替え、その index から /player で再生する。
//
// データ取得は songs.tsx と同じく client.listTracks を React Query で包む（core 専用フックは無い）。
// 検索語が無い／短いうちは投げない（enabled:false）。q は曲名・アーティストの両方に効く。
//
// TV の入力制約への配慮:
//   - 入力は重いので 300ms デバウンスしてから問い合わせる（mobile と同値）。
//   - 1 文字だと巨大ヒット＝全件転送になり得るため最小 2 文字ガード（mobile と同値）。
//   - 結果リストの先頭行には hasTVPreferredFocus を付けない。結果更新のたびに
//     フォーカスが入力欄からリストへ飛ぶのを防ぎ、入力中はキーボードに留める。
//     ユーザーは入力欄から下キーでリストへ降りる。

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { View, Text, TextInput, StyleSheet } from "react-native";

import { type Track, useConnection, usePlayer } from "@crateforge/core";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

/** 大規模ライブラリでも全件取得（mobile の BROWSE_LIMIT と同値）。 */
const BROWSE_LIMIT = 100000;

/** これ未満の検索語は投げない（1 文字＝巨大ヒット回避。mobile と同値）。 */
const MIN_QUERY_LENGTH = 2;

export default function SearchScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // 入力はデバウンス（入力ごとに叩かない）。
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [inputFocused, setInputFocused] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // 最小長を満たすときだけ有効な検索語にする（満たさなければ undefined＝問い合わせ無し）。
  const term = debounced.length >= MIN_QUERY_LENGTH ? debounced : undefined;
  const searching = term != null;

  // q は曲名・アーティストの両方に効く。名前昇順で取得。
  const query = useQuery<Track[]>({
    queryKey: ["tracks", { q: term, limit: BROWSE_LIMIT, sort: "name", order: "asc" }],
    enabled: !!client && searching,
    queryFn: ({ signal }) =>
      client!.listTracks({ q: term, limit: BROWSE_LIMIT, sort: "name", order: "asc" }, signal),
    placeholderData: keepPreviousData,
  });

  // 検索語が無いときは結果を出さない（前回結果が残らないよう空配列に倒す）。
  const tracks = searching ? (query.data ?? []) : [];

  // 行選択: 検索結果をキューにして、その index から再生して Now Playing へ。
  const onSelect = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  // 検索語の有無で空状態の文言を変える（未入力＝案内 / 入力済み 0 件＝該当なし）。
  const emptyMessage = searching
    ? `「${debounced}」に一致する曲がありません`
    : "曲名・アーティスト名で検索してください";

  return (
    <View style={styles.container}>
      <Text style={styles.title}>検索</Text>

      <View style={styles.searchRow}>
        <TextInput
          style={[styles.input, inputFocused && styles.inputFocused]}
          value={search}
          onChangeText={setSearch}
          placeholder="曲名・アーティスト名"
          placeholderTextColor={PALETTE.textSub}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="検索"
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
        />
        {search !== "" ? (
          <Focusable
            onSelect={() => setSearch("")}
            style={styles.clearButton}
            accessibilityLabel="検索をクリア"
          >
            <Text style={styles.clearText}>クリア</Text>
          </Focusable>
        ) : null}
      </View>

      <LibraryList
        data={tracks}
        keyExtractor={(t) => String(t.trackId)}
        isLoading={searching && query.isLoading}
        isError={searching && query.isError}
        errorMessage="検索に失敗しました"
        emptyMessage={emptyMessage}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            active={currentTrackId === item.trackId}
            onSelect={() => onSelect(index)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.bg,
    paddingHorizontal: TV_LAYOUT.contentPaddingH,
    paddingVertical: TV_LAYOUT.contentPaddingV,
  },
  title: {
    fontSize: TV_FONT.lg,
    fontWeight: "700",
    color: PALETTE.teal,
    marginBottom: 24,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
  },
  input: {
    flex: 1,
    backgroundColor: PALETTE.surface,
    color: PALETTE.text,
    fontSize: TV_FONT.md,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: PALETTE.border,
  },
  inputFocused: {
    borderColor: FOCUS_RING.borderColor,
    backgroundColor: PALETTE.focusBg,
  },
  clearButton: {
    backgroundColor: PALETTE.surface,
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 8,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  clearText: {
    color: PALETTE.text,
    fontSize: TV_FONT.sm,
    fontWeight: "600",
  },
});
