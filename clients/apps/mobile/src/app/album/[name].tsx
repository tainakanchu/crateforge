// アルバム詳細。アルバム名 + 曲数 + 「再生」（全曲をキューにして先頭から）+ 一括ダウンロード。
// 曲を一覧し、タップでその位置からアルバム全体をキューにして再生する。

import { useMemo } from "react";
import { FlatList, Pressable, RefreshControl, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import {
  type ArtistGrouping,
  type Track,
  trackArtist,
  filterAlbumTracks,
  trackAlbumArtist,
  useConnection,
  usePlayer,
  useDownloads,
  describeApiError,
} from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import BackButton from "@/components/BackButton";
import DesktopPlayButton from "@/components/DesktopPlayButton";
import TrackRow from "@/components/TrackRow";
import DownloadButton from "@/components/DownloadButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { useAlbumTracks, useArtistTracks } from "@/features/browse/hooks";
import { showTrackMenu } from "@/features/playback/trackMenu";
import { usePullToRefresh } from "@/hooks/use-refresh";

/** disc 番号 → トラック番号 の収録順比較。 */
function byDiscTrack(a: Track, b: Track): number {
  return (a.discNumber ?? 0) - (b.discNumber ?? 0) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0);
}

export default function AlbumScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    name?: string;
    noAlbum?: string;
    artist?: string;
    grouping?: string;
  }>();
  // 「アルバムなし」モード: 指定アーティストの album が空の曲を集めて表示する。
  const isNoAlbum = params.noAlbum === "1";
  const album = params.name ? decodeURIComponent(params.name) : "";
  const artist = params.artist ? decodeURIComponent(params.artist) : "";
  const grouping: ArtistGrouping = params.grouping === "albumArtist" ? "albumArtist" : "artist";
  const title = isNoAlbum ? "アルバムなし" : album || "アルバム";
  const client = useConnection((s) => s.client);

  // 通常はアルバム名（完全一致）で取得。一覧と同じ粒度にするため albumArtist では絞らない（round-2 M1）。
  // アルバムなしはアーティストの曲から album 空を抽出する。
  const albumQuery = useAlbumTracks(isNoAlbum ? null : album || null);
  const artistQuery = useArtistTracks(isNoAlbum ? artist || null : null, grouping);
  const query = isNoAlbum ? artistQuery : albumQuery;
  const { refreshing, onRefresh } = usePullToRefresh(query.refetch);
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  const onlineTracks = useMemo<Track[]>(() => {
    if (isNoAlbum) return [...(artistQuery.data ?? [])].filter((t) => !t.album).sort(byDiscTrack);
    return albumQuery.data ?? [];
  }, [isNoAlbum, artistQuery.data, albumQuery.data]);

  // オフライン時はダウンロード済みエントリから絞る（通常=album 名 / アルバムなし=artist かつ album 空）。
  const entries = useDownloads((s) => s.entries);
  const offlineTracks = useMemo(() => {
    if (client) return [] as Track[];
    if (isNoAlbum) {
      const nameOf = grouping === "albumArtist" ? trackAlbumArtist : trackArtist;
      return Object.values(entries)
        .map((e) => e.track)
        .filter((t) => nameOf(t) === artist && !t.album)
        .sort(byDiscTrack);
    }
    return filterAlbumTracks(
      Object.values(entries).map((e) => e.track),
      album,
    ).sort(byDiscTrack);
  }, [client, entries, album, isNoAlbum, artist, grouping]);
  const tracks = client ? onlineTracks : offlineTracks;

  const onPressTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  const onPlayAll = () => {
    if (tracks.length === 0) return;
    // 「再生」は収録順（プレイリスト詳細と同じく、シャッフルは明示ボタンで）。
    usePlayer.getState().setShuffle(false);
    usePlayer.getState().setQueue(tracks, 0);
    router.push("/player");
  };

  const onShuffle = () => {
    if (tracks.length === 0) return;
    usePlayer.getState().setShuffle(true);
    usePlayer.getState().setQueue(tracks, Math.floor(Math.random() * tracks.length));
    router.push("/player");
  };

  return (
    <Screen edges={["top"]}>
      <BackButton />
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {tracks.length > 0 ? <Text style={styles.count}>{tracks.length}曲</Text> : null}
        </View>
      </View>

      {/* オフライン時のバナー */}
      {!client ? (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={15} color={PALETTE.textDim} />
          <Text style={styles.offlineBannerText}>オフライン再生</Text>
        </View>
      ) : null}

      {tracks.length > 0 ? (
        <View style={styles.actions}>
          <Pressable
            onPress={onPlayAll}
            accessibilityRole="button"
            accessibilityLabel="再生"
            style={({ pressed }) => [styles.playButton, pressed && styles.playPressed]}
          >
            <Ionicons name="play" size={18} color={BRAND.accentText} />
            <Text style={styles.playLabel}>再生</Text>
          </Pressable>
          <Pressable
            onPress={onShuffle}
            accessibilityRole="button"
            accessibilityLabel="シャッフル再生"
            style={({ pressed }) => [styles.shuffleButton, pressed && styles.playPressed]}
          >
            <Ionicons name="shuffle" size={18} color={PALETTE.accent} />
            <Text style={styles.shuffleLabel}>シャッフル</Text>
          </Pressable>
          <DesktopPlayButton tracks={tracks} />
          {client && !isNoAlbum ? (
            <DownloadButton albumName={album} label="アルバムを保存" />
          ) : null}
        </View>
      ) : null}

      {client ? (
        query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          <ErrorView message={errorText(query.error)} onRetry={() => query.refetch()} />
        ) : tracks.length === 0 ? (
          <EmptyView message="このアルバムは空です" icon="musical-notes-outline" />
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
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PALETTE.accent} colors={[PALETTE.accent]} />}
          />
        )
      ) : offlineTracks.length === 0 ? (
        <EmptyView
          message="このアルバムはオフライン保存されていません"
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
  return describeApiError(e, { action: "読み込み" });
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
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
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  playButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: PALETTE.accent,
  },
  playPressed: {
    opacity: 0.7,
  },
  playLabel: {
    color: BRAND.accentText,
    fontSize: 14,
    fontWeight: "700",
  },
  shuffleButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PALETTE.accent,
  },
  shuffleLabel: {
    color: PALETTE.accent,
    fontSize: 14,
    fontWeight: "700",
  },
  listContent: {
    paddingBottom: 96,
  },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 4,
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
