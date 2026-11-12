// Playlist 詳細。プレイリスト名 + 曲数 + 一括ダウンロードのヘッダを出し、
// 曲を一覧する。タップでその位置からプレイリスト全体をキューにして再生する。

import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { type Track, useConnection, usePlayer, useDownloads, describeApiError } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import BackButton from "@/components/BackButton";
import DesktopPlayButton from "@/components/DesktopPlayButton";
import TrackRow from "@/components/TrackRow";
import DownloadButton from "@/components/DownloadButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { usePlaylist, usePlaylistTracks } from "@/features/browse/hooks";
import { showTrackMenu } from "@/features/playback/trackMenu";
import { positionalTrackKey } from "@/lib/listKeys";
import { usePullToRefresh } from "@/hooks/use-refresh";

export default function PlaylistScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = Number(id);
  const client = useConnection((s) => s.client);
  const detailQuery = usePlaylist(playlistId);
  const query = usePlaylistTracks(playlistId);
  // プル更新（曲とプレイリスト情報）。
  const { refreshing, onRefresh } = usePullToRefresh(
    useCallback(() => Promise.all([query.refetch(), detailQuery.refetch()]), [query, detailQuery]),
  );
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // オフライン保存したプレイリストとその曲（client が無いときに使う）。
  const dp = useDownloads((s) => s.playlists[playlistId]);
  const entries = useDownloads((s) => s.entries);
  const downloadPlaylist = useDownloads((s) => s.downloadPlaylist);
  const removeDownloadedPlaylist = useDownloads((s) => s.removeDownloadedPlaylist);
  const [pinBusy, setPinBusy] = useState(false);
  const pinned = dp?.pinned === true;
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

  const onPlayAll = () => {
    if (tracks.length === 0) return;
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

  const togglePin = async () => {
    if (pinBusy) return;
    setPinBusy(true);
    try {
      if (pinned) {
        await removeDownloadedPlaylist(playlistId);
      } else if (client && tracks.length > 0) {
        await downloadPlaylist(playlistId, title, tracks, true);
      }
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <Screen edges={["top"]}>
      <BackButton />
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {tracks.length > 0 ? (
            <Text style={styles.count}>{tracks.length}曲</Text>
          ) : null}
        </View>
        {pinned || (client && tracks.length > 0) ? (
          <View style={styles.headerActions}>
            {!pinned && client ? (
              <DownloadButton tracks={tracks} playlist={{ id: playlistId, name: title }} label="ダウンロード" />
            ) : null}
            <Pressable
              onPress={() => void togglePin()}
              disabled={pinBusy}
              accessibilityRole="button"
              accessibilityLabel={pinned ? "ピン留めを解除" : "ピン留め"}
              accessibilityState={{ selected: pinned, disabled: pinBusy }}
              style={({ pressed }) => [
                styles.pinButton,
                pinned && styles.pinButtonActive,
                pressed && styles.pressed,
              ]}
            >
              {pinBusy ? (
                <ActivityIndicator size="small" color={PALETTE.accent} />
              ) : (
                <Ionicons
                  name={pinned ? "pin" : "pin-outline"}
                  size={19}
                  color={pinned ? PALETTE.accent : PALETTE.textDim}
                />
              )}
              <Text style={[styles.pinText, pinned && styles.pinTextActive]}>
                {pinned ? "ピン留め済み" : "ピン留め"}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {tracks.length > 0 ? (
        <View style={styles.actions}>
          <Pressable
            onPress={onPlayAll}
            accessibilityRole="button"
            accessibilityLabel="再生"
            style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
          >
            <Ionicons name="play" size={18} color={BRAND.accentText} />
            <Text style={styles.playLabel}>再生</Text>
          </Pressable>
          <Pressable
            onPress={onShuffle}
            accessibilityRole="button"
            accessibilityLabel="シャッフル再生"
            style={({ pressed }) => [styles.shuffleButton, pressed && styles.pressed]}
          >
            <Ionicons name="shuffle" size={18} color={PALETTE.accent} />
            <Text style={styles.shuffleLabel}>シャッフル</Text>
          </Pressable>
          <DesktopPlayButton tracks={tracks} />
        </View>
      ) : null}

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
            keyExtractor={positionalTrackKey}
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
          message="このプレイリストはオフライン保存されていません"
          icon="cloud-offline-outline"
        />
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={positionalTrackKey}
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
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  playButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 20,
    borderRadius: 22,
    backgroundColor: PALETTE.accent,
  },
  playLabel: { color: BRAND.accentText, fontSize: 15, fontWeight: "700" },
  shuffleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: PALETTE.accent,
  },
  shuffleLabel: { color: PALETTE.accent, fontSize: 15, fontWeight: "700" },
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
  headerActions: {
    alignItems: "flex-end",
  },
  pinButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  pinButtonActive: {
    backgroundColor: PALETTE.surface,
  },
  pinText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  pinTextActive: {
    color: PALETTE.accent,
  },
  pressed: {
    opacity: 0.7,
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
