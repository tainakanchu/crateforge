// Library 画面。検索 + ジャンルチップで曲を絞り込み、タップで「現在のリストを
// キューにして」その位置から再生する。プレイリストへの入口も上部に置く。

import { useEffect, useRef, useState } from "react";
import { FlatList, TextInput, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import type { Track } from "@/lib/types";
import { PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { useConnection } from "@/store/connection";
import { usePlayer } from "@/store/player";
import { useTracks, useGenres } from "@/features/browse/hooks";
import GenreChips from "@/features/browse/GenreChips";
import PlaylistsBar from "@/features/browse/PlaylistsBar";

export default function LibraryScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);

  // 検索はデバウンス（入力ごとに叩かない）。
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [genre, setGenre] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const tracksQuery = useTracks({
    q: debounced || undefined,
    genre: genre ?? undefined,
    limit: 200,
  });
  const genresQuery = useGenres();

  const tracks = tracksQuery.data ?? [];
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);
  const listRef = useRef<FlatList<Track>>(null);

  const onPressTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  if (!client) {
    return (
      <Screen>
        <EmptyView message="サーバーに接続してください" icon="wifi-outline" />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={PALETTE.textFaint} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="曲・アーティストを検索"
          placeholderTextColor={PALETTE.textFaint}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="検索"
        />
        {search !== "" ? (
          <IconButton
            name="close-circle"
            onPress={() => setSearch("")}
            size={18}
            color={PALETTE.textFaint}
            accessibilityLabel="検索をクリア"
          />
        ) : null}
      </View>

      <GenreChips genres={genresQuery.data ?? []} selected={genre} onSelect={setGenre} />

      <FlatList
        ref={listRef}
        data={tracks}
        keyExtractor={(t) => String(t.trackId)}
        ListHeaderComponent={<PlaylistsBar onOpen={(p) => router.push(`/playlist/${p.playlistId}`)} />}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            active={currentTrackId === item.trackId}
            onPress={() => onPressTrack(index)}
            onLongPress={() => usePlayer.getState().enqueueNext(item)}
          />
        )}
        ListEmptyComponent={
          tracksQuery.isLoading ? (
            <Loading />
          ) : tracksQuery.isError ? (
            <ErrorView
              message={errorText(tracksQuery.error)}
              onRetry={() => tracksQuery.refetch()}
            />
          ) : (
            <EmptyView message="曲が見つかりません" icon="musical-notes-outline" />
          )
        }
        contentContainerStyle={tracks.length === 0 ? styles.emptyContent : styles.listContent}
        keyboardShouldPersistTaps="handled"
      />
    </Screen>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "読み込みに失敗しました";
}

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  searchInput: {
    flex: 1,
    color: PALETTE.text,
    fontSize: 15,
    padding: 0,
  },
  listContent: {
    paddingBottom: 96,
  },
  emptyContent: {
    flexGrow: 1,
  },
});
