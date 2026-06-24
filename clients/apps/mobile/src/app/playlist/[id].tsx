// Playlist 詳細。プレイリスト名 + 曲数 + 一括ダウンロードのヘッダを出し、
// 曲を一覧する。タップでその位置からプレイリスト全体をキューにして再生する。

import { useMemo } from "react";
import { FlatList, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { type Track, useConnection, usePlayer, useDownloads } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import DownloadButton from "@/components/DownloadButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { usePlaylist, usePlaylistTracks } from "@/features/browse/hooks";
import { showTrackMenu } from "@/features/playback/trackMenu";

export default function PlaylistScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = Number(id);
  const client = useConnection((s) => s.client);
  const detailQuery = usePlaylist(playlistId);
  const query = usePlaylistTracks(playlistId);
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // オフライン保存したプレイリストとその曲（client が無いときに使う）。
  const dp = useDownloads((s) => s.playlists[playlistId]);
  const entries = useDownloads((s) => s.entries);
  const offlineTracks = useMemo(() => {
    if (!dp) return [] as Track[];
    return dp.trackIds
      .map((tid) => entries[tid]?.track)
      .filter((t): t is Track => t != null);
  }, [dp, entries]);

  const tracks = client ? (query.data ?? []) : offlineTracks;
  const title = client ? (detailQuery.data?.name ?? "プレイリスト") : (dp?.name ?? "プレイリスト");

  const onPressTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  return (
    <Screen edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {tracks.length > 0 ? (
            <Text style={styles.count}>{tracks.length}曲</Text>
          ) : null}
        </View>
        {client && tracks.length > 0 ? (
          <DownloadButton tracks={tracks} playlist={{ id: playlistId, name: title }} label="ダウンロード" />
        ) : null}
      </View>

      {/* オフライン時のバナー */}
      {!client ? (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={15} color={PALETTE.textDim} />
          <Text style={styles.offlineBannerText}>オフライン再生</Text>
        </View>
      ) : null}

      {client ? (
        query.isLoading ? (
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
                onLongPress={() => showTrackMenu(item)}
                trailing={<DownloadButton track={item} />}
              />
            )}
            contentContainerStyle={styles.listContent}
          />
        )
      ) : offlineTracks.length === 0 ? (
        <EmptyView
          message="このプレイリストはオフライン保存されていません"
          icon="cloud-offline-outline"
        />
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
              onLongPress={() => showTrackMenu(item)}
              trailing={<DownloadButton track={item} />}
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
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: "700",
  },
  count: {
    color: PALETTE.textFaint,
    fontSize: 13,
    marginTop: 2,
  },
  listContent: {
    paddingBottom: 96,
  },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 0,
    marginBottom: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  offlineBannerText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
});
