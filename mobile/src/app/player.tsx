// 全画面プレイヤー（モーダル）。大きなアートワーク + トランスポート + シークバー、
// その下に「Up Next」（残りキュー）と「Similar」（現在曲の類似曲）を並べる。
// 依存追加禁止のため、シークバーは Pressable のレイアウト幅から位置を計算する自作。

import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import type { LayoutChangeEvent, GestureResponderEvent } from "react-native";
import { useRouter } from "expo-router";

import { BRAND, PALETTE } from "@/constants/brand";
import type { SimilarHit, Track } from "@/lib/types";
import { formatDuration, trackTitle, trackArtist } from "@/lib/format";
import { useConnection } from "@/store/connection";
import { usePlayer } from "@/store/player";
import Screen from "@/components/Screen";
import Artwork from "@/components/Artwork";
import IconButton from "@/components/IconButton";
import TrackRow from "@/components/TrackRow";

export default function PlayerScreen() {
  const router = useRouter();
  const current = usePlayer((s) => s.current());
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);

  if (!current) {
    return (
      <Screen style={styles.empty}>
        <Text style={styles.emptyText}>再生中の曲はありません</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.closeFab, pressed && styles.pressed]}
        >
          <Text style={styles.closeText}>閉じる</Text>
        </Pressable>
      </Screen>
    );
  }

  const upNext = queue.slice(index + 1);
  const progress =
    durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton
          name="chevron-down"
          size={28}
          onPress={() => router.back()}
          accessibilityLabel="閉じる"
        />
        <Text style={styles.headerLabel}>再生中</Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList<ListItem>
        data={buildList(upNext)}
        keyExtractor={(item) =>
          item.kind === "section"
            ? `section-${item.title}`
            : item.kind === "similar"
              ? "similar-section"
              : `track-${item.track.id}`
        }
        renderItem={({ item }) =>
          item.kind === "section" ? (
            <Text style={styles.sectionTitle}>{item.title}</Text>
          ) : item.kind === "similar" ? (
            <SimilarSection trackId={current.trackId} />
          ) : (
            <TrackRow track={item.track} onPress={item.onPress} />
          )
        }
        ListHeaderComponent={
          <NowPlaying
            current={current}
            progress={progress}
            positionMs={positionMs}
            durationMs={durationMs}
            isPlaying={isPlaying}
            repeat={repeat}
            shuffle={shuffle}
          />
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </Screen>
  );
}

interface NowPlayingProps {
  current: Track;
  progress: number;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  repeat: "off" | "all" | "one";
  shuffle: boolean;
}

function NowPlaying({
  current,
  progress,
  positionMs,
  durationMs,
  isPlaying,
  repeat,
  shuffle,
}: NowPlayingProps) {
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const seek = usePlayer((s) => s.seek);
  const setRepeat = usePlayer((s) => s.setRepeat);
  const setShuffle = usePlayer((s) => s.setShuffle);

  const cycleRepeat = () => {
    setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
  };

  return (
    <View style={styles.nowPlaying}>
      <View style={styles.artWrap}>
        <Artwork track={current} size={ART_SIZE} radius={12} />
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {trackTitle(current)}
      </Text>
      <Text style={styles.artist} numberOfLines={1}>
        {trackArtist(current)}
      </Text>

      <SeekBar progress={progress} durationMs={durationMs} onSeek={seek} />
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatDuration(positionMs)}</Text>
        <Text style={styles.time}>{formatDuration(durationMs)}</Text>
      </View>

      <View style={styles.controls}>
        <IconButton
          name="shuffle"
          size={22}
          color={shuffle ? PALETTE.accent : PALETTE.textDim}
          onPress={() => setShuffle(!shuffle)}
          accessibilityLabel="シャッフル"
        />
        <IconButton
          name="play-skip-back"
          size={30}
          onPress={() => prev()}
          accessibilityLabel="前の曲"
        />
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? "一時停止" : "再生"}
          style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]}
        >
          <IconButton
            name={isPlaying ? "pause" : "play"}
            size={34}
            color={BRAND.accentText}
            onPress={toggle}
          />
        </Pressable>
        <IconButton
          name="play-skip-forward"
          size={30}
          onPress={() => next()}
          accessibilityLabel="次の曲"
        />
        <IconButton
          name={repeat === "one" ? "repeat-outline" : "repeat"}
          size={22}
          color={repeat === "off" ? PALETTE.textDim : PALETTE.accent}
          onPress={cycleRepeat}
          accessibilityLabel="リピート"
        />
      </View>
      {repeat === "one" ? <Text style={styles.repeatHint}>1曲リピート</Text> : null}
    </View>
  );
}

interface SeekBarProps {
  progress: number;
  durationMs: number;
  onSeek: (ms: number) => void;
}

/** レイアウト幅から押下位置を比率にしてシークする自作バー（依存追加なし）。 */
function SeekBar({ progress, durationMs, onSeek }: SeekBarProps) {
  const widthRef = useRef(0);

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
  };

  const handlePress = (e: GestureResponderEvent) => {
    const w = widthRef.current;
    if (w <= 0 || durationMs <= 0) return;
    const x = Math.max(0, Math.min(w, e.nativeEvent.locationX));
    onSeek((x / w) * durationMs);
  };

  return (
    <Pressable
      onLayout={onLayout}
      onPress={handlePress}
      accessibilityRole="adjustable"
      accessibilityLabel="シーク"
      style={styles.seekHit}
    >
      <View style={styles.seekTrack}>
        <View style={[styles.seekFill, { width: `${progress * 100}%` }]} />
      </View>
    </Pressable>
  );
}

/** 現在曲の類似曲を直接 client.similar で取得して表示する自己完結セクション。 */
function SimilarSection({ trackId }: { trackId: number }) {
  const client = useConnection((s) => s.client);
  const [hits, setHits] = useState<SimilarHit[] | null>(null);
  const [error, setError] = useState(false);
  const setQueue = usePlayer((s) => s.setQueue);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    setHits(null);
    setError(false);
    client
      .similar(trackId, { limit: 20 })
      .then((res) => {
        if (alive) setHits(res);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [client, trackId]);

  if (error) {
    return <Text style={styles.similarNote}>類似曲を取得できませんでした</Text>;
  }
  if (hits == null) {
    return (
      <View style={styles.similarLoading}>
        <ActivityIndicator color={PALETTE.accent} />
      </View>
    );
  }
  if (hits.length === 0) {
    return <Text style={styles.similarNote}>類似曲はありません</Text>;
  }

  const tracks = hits.map((h) => h.track);
  return (
    <View>
      {tracks.map((track, i) => (
        <TrackRow
          key={`similar-${track.id}`}
          track={track}
          onPress={() => setQueue(tracks, i)}
        />
      ))}
    </View>
  );
}

// --- リスト構造（ヘッダ下に Up Next と Similar を縦に並べる）---

type ListItem =
  | { kind: "section"; title: string }
  | { kind: "similar" }
  | { kind: "track"; track: Track; onPress: () => void };

function buildList(upNext: Track[]): ListItem[] {
  const items: ListItem[] = [];
  if (upNext.length > 0) {
    items.push({ kind: "section", title: "Up Next" });
    for (const track of upNext) {
      items.push({ kind: "track", track, onPress: () => playFromUpNext(track) });
    }
  }
  items.push({ kind: "section", title: "Similar" });
  items.push({ kind: "similar" });
  return items;
}

/** Up Next の曲をタップ：現在キュー内のその位置から再生する。 */
function playFromUpNext(track: Track): void {
  const { queue, playAt } = usePlayer.getState();
  const at = queue.findIndex((t) => t.id === track.id);
  if (at >= 0) playAt(at);
}

const ART_SIZE = 280;

const styles = StyleSheet.create({
  empty: { alignItems: "center", justifyContent: "center", gap: 16 },
  emptyText: { color: PALETTE.textDim, fontSize: 16 },
  closeFab: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: PALETTE.accent,
  },
  closeText: { color: BRAND.accentText, fontWeight: "700" },
  pressed: { opacity: 0.7 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerLabel: {
    flex: 1,
    textAlign: "center",
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  headerSpacer: { width: 40 },

  listContent: { paddingBottom: 32 },

  nowPlaying: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  artWrap: {
    alignItems: "center",
    marginBottom: 24,
  },
  title: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  artist: {
    color: PALETTE.textDim,
    fontSize: 15,
    textAlign: "center",
    marginTop: 6,
  },

  seekHit: {
    marginTop: 24,
    paddingVertical: 8,
  },
  seekTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: PALETTE.border,
    overflow: "hidden",
  },
  seekFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: PALETTE.accent,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 2,
  },
  time: {
    color: PALETTE.textFaint,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },

  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 20,
  },
  playBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: PALETTE.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  repeatHint: {
    color: PALETTE.textFaint,
    fontSize: 11,
    textAlign: "center",
    marginTop: 8,
  },

  sectionTitle: {
    color: PALETTE.text,
    fontSize: 16,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  similarLoading: {
    paddingVertical: 20,
    alignItems: "center",
  },
  similarNote: {
    color: PALETTE.textDim,
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
