// 全画面プレイヤー（モーダル）。大きなアートワーク + トランスポート + シークバー、
// その下に「Up Next」（残りキュー）と「Similar」（現在曲の類似曲）を並べる。
// 依存追加禁止のため、シークバーは Pressable のレイアウト幅から位置を計算する自作。

import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Modal,
} from "react-native";
import type { LayoutChangeEvent, GestureResponderEvent } from "react-native";
import { useRouter } from "expo-router";

import { BRAND, PALETTE } from "@/constants/brand";
import { type SimilarHit, type Track, formatDuration, ratingToStars, trackTitle, trackArtist, trackAlbumArtist, useConnection, usePlayer, useSettings } from "@crateforge/core";
import Screen from "@/components/Screen";
import Artwork from "@/components/Artwork";
import IconButton from "@/components/IconButton";
import TrackRow from "@/components/TrackRow";
import RatingStars from "@/components/RatingStars";
import { useSetRating } from "@/features/browse/hooks";

// 再生速度の選択肢
const RATE_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0] as const;
type RateOption = (typeof RATE_OPTIONS)[number];

// スリープタイマーの選択肢（ms | "trackEnd" | null）
type SleepTimerOption = number | "trackEnd" | null;
const SLEEP_TIMER_OPTIONS: { label: string; value: SleepTimerOption }[] = [
  { label: "オフ", value: null },
  { label: "15分", value: 15 * 60 * 1000 },
  { label: "30分", value: 30 * 60 * 1000 },
  { label: "60分", value: 60 * 60 * 1000 },
  { label: "曲の終わりで", value: "trackEnd" },
];

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
  const playbackRate = usePlayer((s) => s.playbackRate);
  const sleepTimerMs = usePlayer((s) => s.sleepTimerMs);
  const stopAtTrackEnd = usePlayer((s) => s.stopAtTrackEnd);

  // スリープタイマー実装：ms モードは setTimeout で自動停止
  useEffect(() => {
    if (sleepTimerMs == null) return;
    const id = setTimeout(() => {
      usePlayer.getState().pause();
      usePlayer.getState().setSleepTimer(null);
    }, sleepTimerMs);
    return () => clearTimeout(id);
  }, [sleepTimerMs]);

  // 「曲の終わりで停止」モード：
  // _onFinished → next(true) が呼ばれると index が変わり isPlaying が一瞬 true になる。
  // index の変化を検知してその直後に pause/フラグクリアする。
  const prevIndexRef = useRef(index);
  useEffect(() => {
    if (!stopAtTrackEnd) {
      prevIndexRef.current = index;
      return;
    }
    if (index !== prevIndexRef.current) {
      // 曲が変わった＝トラック終了後に next が走った。すぐ停止。
      usePlayer.getState().pause();
      usePlayer.getState().setStopAtTrackEnd(false);
    }
    prevIndexRef.current = index;
  }, [index, stopAtTrackEnd]);

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
        data={buildList(upNext, index)}
        keyExtractor={(item) =>
          item.kind === "section"
            ? `section-${item.title}`
            : item.kind === "similar"
              ? "similar-section"
              : item.kind === "upnext-track"
                ? `upnext-${item.queueIndex}`
                : `track-${item.track.id}`
        }
        renderItem={({ item }) =>
          item.kind === "section" ? (
            <Text style={styles.sectionTitle}>{item.title}</Text>
          ) : item.kind === "similar" ? (
            <SimilarSection trackId={current.trackId} />
          ) : item.kind === "upnext-track" ? (
            <UpNextRow
              track={item.track}
              queueIndex={item.queueIndex}
              onPress={item.onPress}
            />
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
            playbackRate={playbackRate}
            sleepTimerMs={sleepTimerMs}
            stopAtTrackEnd={stopAtTrackEnd}
          />
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </Screen>
  );
}

// Up Next の各行（削除＋並べ替えボタン付き）
interface UpNextRowProps {
  track: Track;
  queueIndex: number;
  onPress: () => void;
}

function UpNextRow({ track, queueIndex, onPress }: UpNextRowProps) {
  const queue = usePlayer((s) => s.queue);
  const removeQueueAt = usePlayer((s) => s.removeQueueAt);
  const moveQueueItem = usePlayer((s) => s.moveQueueItem);

  return (
    <View style={styles.upNextRow}>
      <View style={styles.upNextArrows}>
        <TouchableOpacity
          onPress={() => moveQueueItem(queueIndex, queueIndex - 1)}
          disabled={queueIndex <= 0}
          accessibilityLabel="上へ移動"
          style={styles.arrowBtn}
        >
          <Text style={[styles.arrowText, queueIndex <= 0 && styles.arrowDisabled]}>▲</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => moveQueueItem(queueIndex, queueIndex + 1)}
          disabled={queueIndex >= queue.length - 1}
          accessibilityLabel="下へ移動"
          style={styles.arrowBtn}
        >
          <Text style={[styles.arrowText, queueIndex >= queue.length - 1 && styles.arrowDisabled]}>▼</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.upNextTrack}>
        <TrackRow track={track} onPress={onPress} />
      </View>
      <TouchableOpacity
        onPress={() => removeQueueAt(queueIndex)}
        accessibilityLabel="キューから削除"
        style={styles.removeBtn}
      >
        <Text style={styles.removeText}>✕</Text>
      </TouchableOpacity>
    </View>
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
  playbackRate: number;
  sleepTimerMs: number | null;
  stopAtTrackEnd: boolean;
}

function NowPlaying({
  current,
  progress,
  positionMs,
  durationMs,
  isPlaying,
  repeat,
  shuffle,
  playbackRate,
  sleepTimerMs,
  stopAtTrackEnd,
}: NowPlayingProps) {
  const router = useRouter();
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const seek = usePlayer((s) => s.seek);
  const setRepeat = usePlayer((s) => s.setRepeat);
  const setShuffle = usePlayer((s) => s.setShuffle);
  const setRate = usePlayer((s) => s.setRate);
  const setSleepTimer = usePlayer((s) => s.setSleepTimer);
  const setStopAtTrackEnd = usePlayer((s) => s.setStopAtTrackEnd);

  // アーティストページへ遷移（"Unknown Artist" のときは no-op）。
  // 束ね方は設定に追従させ、artist ページの絞り込みと一致させる。
  const artistGrouping = useSettings((s) => s.artistGrouping);
  const artistName =
    artistGrouping === "albumArtist" ? trackAlbumArtist(current) : trackArtist(current);
  const handleArtistPress = () => {
    if (artistName === "Unknown Artist") return;
    router.push(`/artist/${encodeURIComponent(artistName)}`);
  };

  const [showRatePicker, setShowRatePicker] = useState(false);
  const [showSleepPicker, setShowSleepPicker] = useState(false);

  const cycleRepeat = () => {
    setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off");
  };

  const skip = useCallback(
    (ms: number) => {
      seek(Math.max(0, positionMs + ms));
    },
    [seek, positionMs],
  );

  const rateLabel = playbackRate === 1 ? "1.0x" : `${playbackRate}x`;

  const hasSleepTimer = sleepTimerMs != null || stopAtTrackEnd;
  const sleepLabel = stopAtTrackEnd
    ? "曲末"
    : sleepTimerMs != null
      ? `${Math.round(sleepTimerMs / 60000)}分`
      : null;

  const handleSleepChoice = (value: SleepTimerOption) => {
    setShowSleepPicker(false);
    if (value === "trackEnd") {
      setStopAtTrackEnd(true);
    } else {
      setSleepTimer(value);
    }
  };

  return (
    <View style={styles.nowPlaying}>
      <View style={styles.artWrap}>
        <Artwork track={current} size={ART_SIZE} radius={12} />
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {trackTitle(current)}
      </Text>

      {/* アーティスト名：タップでアーティストページへ。Unknown Artist のときは遷移しない */}
      <Pressable
        onPress={handleArtistPress}
        disabled={artistName === "Unknown Artist"}
        accessibilityRole="link"
        accessibilityLabel={`アーティスト: ${artistName}`}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Text
          style={[
            styles.artist,
            artistName !== "Unknown Artist" && styles.artistTappable,
          ]}
          numberOfLines={1}
        >
          {artistName}
        </Text>
      </Pressable>

      {/* アルバム名：存在するときのみ表示。タップでアルバムページへ */}
      {current.album != null && (
        <Pressable
          onPress={() =>
            router.push(`/album/${encodeURIComponent(current.album!)}`)
          }
          accessibilityRole="link"
          accessibilityLabel={`アルバム: ${current.album}`}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={styles.album} numberOfLines={1}>
            {current.album}
          </Text>
        </Pressable>
      )}

      {/* レーティング（★×5・タップで設定）。current が変わるたびに id をキーにして再マウントし、
          別の曲の楽観的状態が引き継がれないようにする。 */}
      <RatingControl key={current.id} track={current} />

      <SeekBar progress={progress} durationMs={durationMs} onSeek={seek} />
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatDuration(positionMs)}</Text>
        <Text style={styles.time}>{formatDuration(durationMs)}</Text>
      </View>

      {/* メインコントロール行：-15s / prev / play / next / +15s */}
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

      {/* ±15秒スキップ行 */}
      <View style={styles.skipRow}>
        <TouchableOpacity
          onPress={() => skip(-15000)}
          accessibilityLabel="-15秒"
          style={styles.skipBtn}
        >
          <Text style={styles.skipText}>-15s</Text>
        </TouchableOpacity>
        <View style={styles.skipCenter} />
        <TouchableOpacity
          onPress={() => skip(15000)}
          accessibilityLabel="+15秒"
          style={styles.skipBtn}
        >
          <Text style={styles.skipText}>+15s</Text>
        </TouchableOpacity>
      </View>

      {/* 再生速度 + スリープタイマー行 */}
      <View style={styles.secondaryRow}>
        {/* 再生速度 */}
        <TouchableOpacity
          onPress={() => setShowRatePicker(true)}
          accessibilityLabel="再生速度"
          style={[styles.secondaryBtn, playbackRate !== 1 && styles.secondaryBtnActive]}
        >
          <Text style={[styles.secondaryBtnText, playbackRate !== 1 && styles.secondaryBtnTextActive]}>
            {rateLabel}
          </Text>
        </TouchableOpacity>

        <View style={styles.secondaryCenter} />

        {/* スリープタイマー */}
        <TouchableOpacity
          onPress={() => setShowSleepPicker(true)}
          accessibilityLabel="スリープタイマー"
          style={[styles.secondaryBtn, hasSleepTimer && styles.secondaryBtnActive]}
        >
          <Text style={[styles.secondaryBtnText, hasSleepTimer && styles.secondaryBtnTextActive]}>
            🌙{sleepLabel ? ` ${sleepLabel}` : ""}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 再生速度ピッカー モーダル */}
      <Modal
        visible={showRatePicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowRatePicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowRatePicker(false)}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>再生速度</Text>
            {RATE_OPTIONS.map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => {
                  setRate(r);
                  setShowRatePicker(false);
                }}
                style={[styles.pickerRow, r === playbackRate && styles.pickerRowActive]}
              >
                <Text style={[styles.pickerRowText, r === playbackRate && styles.pickerRowTextActive]}>
                  {r === 1 ? "1.0x（標準）" : `${r}x`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* スリープタイマーピッカー モーダル */}
      <Modal
        visible={showSleepPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSleepPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowSleepPicker(false)}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>スリープタイマー</Text>
            {SLEEP_TIMER_OPTIONS.map((opt) => {
              const isActive =
                opt.value === "trackEnd"
                  ? stopAtTrackEnd
                  : opt.value === null
                    ? sleepTimerMs == null && !stopAtTrackEnd
                    : sleepTimerMs === opt.value;
              return (
                <TouchableOpacity
                  key={String(opt.value)}
                  onPress={() => handleSleepChoice(opt.value)}
                  style={[styles.pickerRow, isActive && styles.pickerRowActive]}
                >
                  <Text style={[styles.pickerRowText, isActive && styles.pickerRowTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * 現在曲のレーティング（★×5）をタップで設定するコントロール。
 * - 表示は楽観的ローカル state。タップ即時に星を更新し、サーバ呼び出しが失敗したら元に戻す。
 * - 同じ星を再タップすると 0（未設定）にクリア（RatingStars 側のロジック）。
 * - オフライン（client null）時は操作不可（淡色表示）。
 * - 成功/失敗後に rating を含むクエリ群を invalidate（useSetRating 内）。
 */
function RatingControl({ track }: { track: Track }) {
  const client = useConnection((s) => s.client);
  const setRating = useSetRating();
  // サーバ確定値（track.rating 由来）の星数。track が変わると key 再マウントで初期化される。
  const serverStars = ratingToStars(track.rating);
  const [stars, setStars] = useState(serverStars);

  const handleChange = (next: number) => {
    if (!client) return;
    const prev = stars;
    setStars(next); // 楽観的更新
    setRating.mutate(
      { trackId: track.id, rating: next * 20 },
      {
        onError: () => setStars(prev), // 失敗したら元に戻す
      },
    );
  };

  return (
    <View style={styles.ratingRow}>
      <RatingStars
        value={stars}
        onChange={handleChange}
        disabled={!client}
        size={26}
      />
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
  | { kind: "upnext-track"; track: Track; queueIndex: number; onPress: () => void }
  | { kind: "track"; track: Track; onPress: () => void };

function buildList(upNext: Track[], currentIndex: number): ListItem[] {
  const items: ListItem[] = [];
  if (upNext.length > 0) {
    items.push({ kind: "section", title: "Up Next" });
    for (let i = 0; i < upNext.length; i++) {
      const track = upNext[i];
      const queueIndex = currentIndex + 1 + i;
      items.push({
        kind: "upnext-track",
        track,
        queueIndex,
        onPress: () => playFromUpNext(track),
      });
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
  // アーティスト名がタップ可能なとき、accent 色で下線を付けて示す
  artistTappable: {
    color: PALETTE.accent,
    textDecorationLine: "underline",
  },
  // アルバム名（アーティストの下に控えめに表示）
  album: {
    color: PALETTE.textDim,
    fontSize: 13,
    textAlign: "center",
    marginTop: 3,
    textDecorationLine: "underline",
  },

  ratingRow: {
    alignItems: "center",
    marginTop: 14,
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

  // ±15秒スキップ行
  skipRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  skipBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  skipText: {
    color: PALETTE.textDim,
    fontSize: 14,
    fontWeight: "600",
  },
  skipCenter: { flex: 1 },

  // 再生速度・スリープタイマー行
  secondaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    marginBottom: 8,
  },
  secondaryCenter: { flex: 1 },
  secondaryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  secondaryBtnActive: {
    borderColor: PALETTE.accent,
    backgroundColor: PALETTE.surfaceAlt,
  },
  secondaryBtnText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  secondaryBtnTextActive: {
    color: PALETTE.accent,
  },

  // Up Next 行
  upNextRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 8,
  },
  upNextArrows: {
    flexDirection: "column",
    alignItems: "center",
    paddingLeft: 8,
    paddingRight: 4,
    gap: 2,
  },
  arrowBtn: {
    padding: 4,
  },
  arrowText: {
    color: PALETTE.textDim,
    fontSize: 11,
  },
  arrowDisabled: {
    color: PALETTE.border,
  },
  upNextTrack: {
    flex: 1,
  },
  removeBtn: {
    padding: 10,
  },
  removeText: {
    color: PALETTE.textFaint,
    fontSize: 16,
  },

  // モーダル
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  pickerSheet: {
    backgroundColor: PALETTE.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
    paddingTop: 16,
  },
  pickerTitle: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  pickerRow: {
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  pickerRowActive: {
    backgroundColor: PALETTE.surfaceAlt,
  },
  pickerRowText: {
    color: PALETTE.text,
    fontSize: 16,
  },
  pickerRowTextActive: {
    color: PALETTE.accent,
    fontWeight: "700",
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
