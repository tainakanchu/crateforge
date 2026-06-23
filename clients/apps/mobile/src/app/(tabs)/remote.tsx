// Remote 画面。デスクトップ側の再生を操作する（端末自身の再生ではない）。
// 状態をポーリングし、トランスポート操作・シーク・キュー再生を送る。

import { useMemo } from "react";
import { FlatList, Text, View, StyleSheet } from "react-native";

import Screen from "@/components/Screen";
import Artwork from "@/components/Artwork";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { BRAND, PALETTE } from "@/constants/brand";
import { trackTitle, trackArtist, type Track, useConnection } from "@crateforge/core";
import {
  useRemoteState,
  useRemoteQueue,
  useRemoteQueueTracks,
  useRemoteCommands,
} from "@/features/remote/hooks";
import SeekBar from "@/features/remote/SeekBar";

export default function RemoteScreen() {
  const client = useConnection((s) => s.client);
  const state = useRemoteState();
  const queue = useRemoteQueue();
  const queueTracks = useRemoteQueueTracks();
  const cmd = useRemoteCommands();

  const trackIds = queue.data?.trackIds ?? [];
  const currentIndex = queue.data?.currentIndex ?? null;
  const tracks = queueTracks.data ?? [];

  // currentTrackId に一致する Track を解決（キュー優先・無ければ currentIndex）。
  const currentTrack = useMemo<Track | null>(() => {
    const id = state.data?.currentTrackId;
    if (id != null) {
      const hit = tracks.find((t) => t.trackId === id);
      if (hit) return hit;
    }
    if (currentIndex != null && tracks[currentIndex]) return tracks[currentIndex];
    return null;
  }, [state.data?.currentTrackId, tracks, currentIndex]);

  if (!client) {
    return (
      <Screen>
        <EmptyView message="サーバーに接続してください" icon="cloud-offline-outline" />
      </Screen>
    );
  }

  if (state.isPending && !state.data) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  if (state.isError && !state.data) {
    const message = state.error instanceof Error ? state.error.message : "状態を取得できません";
    return (
      <Screen>
        <ErrorView message={message} onRetry={() => void state.refetch()} />
      </Screen>
    );
  }

  const isPlaying = state.data?.isPlaying ?? false;
  const positionMs = state.data?.positionMs ?? 0;
  const durationMs = state.data?.durationMs ?? 0;

  const onTogglePlay = () => {
    if (isPlaying) void cmd.pause();
    else void cmd.resume();
  };

  const onPressRow = (track: Track, index: number) => {
    if (trackIds.length > 0) void cmd.setQueue(trackIds, index);
    else void cmd.play(track.trackId);
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.heading}>Remote</Text>
        <Text style={styles.sub}>デスクトップを操作</Text>
      </View>

      <View style={styles.nowPlaying}>
        {currentTrack ? (
          <Artwork track={currentTrack} size={72} radius={8} />
        ) : (
          <View style={styles.artPlaceholder} />
        )}
        <View style={styles.npTexts}>
          <Text style={styles.npTitle} numberOfLines={1}>
            {currentTrack ? trackTitle(currentTrack) : "再生中の曲なし"}
          </Text>
          <Text style={styles.npArtist} numberOfLines={1}>
            {currentTrack ? trackArtist(currentTrack) : "—"}
          </Text>
        </View>
      </View>

      <View style={styles.seekWrap}>
        <SeekBar
          positionMs={positionMs}
          durationMs={durationMs}
          onSeek={(ms) => void cmd.seek(ms)}
          disabled={durationMs <= 0}
        />
      </View>

      <View style={styles.transport}>
        <IconButton
          name="play-skip-back"
          size={30}
          onPress={() => void cmd.prev()}
          accessibilityLabel="前の曲"
        />
        <IconButton
          name={isPlaying ? "pause-circle" : "play-circle"}
          size={64}
          color={BRAND.accent}
          onPress={onTogglePlay}
          accessibilityLabel={isPlaying ? "一時停止" : "再生"}
        />
        <IconButton
          name="play-skip-forward"
          size={30}
          onPress={() => void cmd.next()}
          accessibilityLabel="次の曲"
        />
        <IconButton
          name="stop"
          size={26}
          onPress={() => void cmd.stop()}
          accessibilityLabel="停止"
        />
      </View>

      <Text style={styles.queueLabel}>キュー{trackIds.length > 0 ? ` (${trackIds.length})` : ""}</Text>

      {queueTracks.isPending && trackIds.length > 0 ? (
        <Loading />
      ) : tracks.length === 0 ? (
        <EmptyView message="キューは空です" icon="list-outline" />
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(t, i) => `${t.trackId}-${i}`}
          renderItem={({ item, index }) => (
            <TrackRow
              track={item}
              index={index + 1}
              active={index === currentIndex}
              onPress={() => onPressRow(item, index)}
            />
          )}
          contentContainerStyle={styles.listContent}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  heading: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: "700",
  },
  sub: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  nowPlaying: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  artPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: PALETTE.surfaceAlt,
  },
  npTexts: {
    flex: 1,
    minWidth: 0,
  },
  npTitle: {
    color: PALETTE.text,
    fontSize: 17,
    fontWeight: "700",
  },
  npArtist: {
    color: PALETTE.textDim,
    fontSize: 14,
    marginTop: 4,
  },
  seekWrap: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  transport: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    paddingVertical: 12,
  },
  queueLabel: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  listContent: {
    // ミニプレイヤー（全画面常時表示）に最下部の行が隠れないよう余白を確保。
    paddingBottom: 96,
  },
});
