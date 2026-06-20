// Playlist 詳細。プレイリスト内の曲を一覧し、タップでその位置から
// プレイリスト全体をキューにして再生する。

import { FlatList, Text, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import type { Track } from "@/lib/types";
import { PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { useConnection } from "@/store/connection";
import { usePlayer } from "@/store/player";
import { usePlaylistTracks } from "@/features/browse/hooks";

export default function PlaylistScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = Number(id);
  const client = useConnection((s) => s.client);
  const query = usePlaylistTracks(playlistId);
  const tracks = query.data ?? [];
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  const onPressTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  return (
    <Screen edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>プレイリスト</Text>
        {tracks.length > 0 ? (
          <Text style={styles.count}>{tracks.length}曲</Text>
        ) : null}
      </View>

      {!client ? (
        <EmptyView message="サーバーに接続してください" icon="wifi-outline" />
      ) : query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <ErrorView message={errorText(query.error)} onRetry={() => query.refetch()} />
      ) : tracks.length === 0 ? (
        <EmptyView message="このプレイリストは空です" icon="musical-notes-outline" />
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(t) => String(t.trackId)}
          renderItem={({ item, index }: { item: Track; index: number }) => (
            <TrackRow
              track={item}
              index={index + 1}
              active={currentTrackId === item.trackId}
              onPress={() => onPressTrack(index)}
              onLongPress={() => usePlayer.getState().enqueueNext(item)}
            />
          )}
          contentContainerStyle={styles.listContent}
        />
      )}
    </Screen>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "読み込みに失敗しました";
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: "700",
  },
  count: {
    color: PALETTE.textFaint,
    fontSize: 13,
  },
  listContent: {
    paddingBottom: 96,
  },
});
