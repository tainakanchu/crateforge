// Remote 画面。デスクトップ側の再生を操作する（端末自身の再生ではない）。
// 状態をポーリングし、トランスポート操作・シーク・キュー再生を送る。

import { useMemo } from "react";
import { FlatList, Text, View, StyleSheet } from "react-native";

import Screen from "@/components/Screen";
import Artwork from "@/components/Artwork";
import ConnectionNotice from "@/components/ConnectionNotice";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { BRAND, PALETTE } from "@/constants/brand";
import { describeApiError, trackTitle, trackArtist, type Track, useConnection } from "@crateforge/core";
import {
  usePollingActive,
  useRemoteState,
  useRemoteQueue,
  useRemoteQueueTracks,
  useRemoteCommands,
} from "@/features/remote/hooks";
import SeekBar from "@/features/remote/SeekBar";
import { disconnectedBody } from "@/lib/connectionStatus";
import ModeControls from "@/features/remote/ModeControls";

export default function RemoteScreen() {
  const client = useConnection((s) => s.client);
  const connStatus = useConnection((s) => s.status);
  const connErrorKind = useConnection((s) => s.errorKind);
  const connChecking = useConnection((s) => s.checking);
  const connLastOkAt = useConnection((s) => s.lastOkAt);
  const connBaseUrl = useConnection((s) => s.baseUrl);
  // タブが裏に回っている間・アプリがバックグラウンドの間はポーリングしない。
  const active = usePollingActive();
  const state = useRemoteState(active);
  const queue = useRemoteQueue(active);
  const queueTracks = useRemoteQueueTracks(active);
  const cmd = useRemoteCommands();

  const trackIds = useMemo(() => queue.data?.trackIds ?? [], [queue.data?.trackIds]);
  const currentIndex = queue.data?.currentIndex ?? null;
  const tracks = useMemo(() => queueTracks.data ?? [], [queueTracks.data]);

  // キューの行はサーバーの再生順（trackIds）の位置で持つ。by-ids は欠けた曲（削除済み等）を
  // 返さないことがあるので、位置ずれを起こさないよう trackId で引き直す。
  const rows = useMemo(() => {
    const byId = new Map(tracks.map((t) => [t.trackId, t] as const));
    const out: { track: Track; index: number }[] = [];
    trackIds.forEach((id, index) => {
      const track = byId.get(id);
      if (track) out.push({ track, index });
    });
    return out;
  }, [trackIds, tracks]);

  // currentTrackId に一致する Track を解決（キュー優先・無ければ currentIndex）。
  const currentTrack = useMemo<Track | null>(() => {
    const id = state.data?.currentTrackId;
    if (id != null) {
      const hit = tracks.find((t) => t.trackId === id);
      if (hit) return hit;
    }
    if (currentIndex != null) {
      const row = rows.find((r) => r.index === currentIndex);
      if (row) return row.track;
    }
    return null;
  }, [state.data?.currentTrackId, tracks, rows, currentIndex]);

  if (!client) {
    // 本文はバナーと矛盾しないよう状態で出し分ける（オフライン中に「接続してください」と出さない。round-3 N2）。
    const body = disconnectedBody({
      status: connStatus,
      errorKind: connErrorKind,
      checking: connChecking,
      lastOkAt: connLastOkAt,
      baseUrl: connBaseUrl,
    });
    return (
      <Screen>
        {/* 未接続の理由 1 行 + 復帰導線（トークン再入力 / 再試行 / 接続画面へ）。 */}
        <ConnectionNotice />
        <EmptyView message={body.message} icon={body.icon} />
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
    const message = describeApiError(state.error, { action: "再生状態の取得" });
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

  // 行タップ: キュー順を保ったままその位置から再生する（play-at。古いホストは set-queue+play）。
  const onPressRow = (track: Track, index: number) => {
    if (trackIds.length > 0) void cmd.playAt(index, trackIds);
    else void cmd.play(track.trackId);
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.heading}>リモート</Text>
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

      <ModeControls
        state={state.data}
        onVolume={(v) => void cmd.setVolume(v)}
        onShuffle={(on) => void cmd.setShuffle(on)}
        onRepeat={(m) => void cmd.setRepeat(m)}
      />

      <Text style={styles.queueLabel}>キュー{trackIds.length > 0 ? ` (${trackIds.length})` : ""}</Text>

      {queueTracks.isPending && trackIds.length > 0 ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyView message="キューは空です" icon="list-outline" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => `${r.track.trackId}-${r.index}`}
          renderItem={({ item }) => (
            <TrackRow
              track={item.track}
              index={item.index + 1}
              active={item.index === currentIndex}
              onPress={() => onPressRow(item.track, item.index)}
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
