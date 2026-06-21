// Crateforge TV ライブラリ画面。
// D-pad でナビゲーション可能な大きなリスト。
// トラックを選択 → キューをセットして /player へ。

import { useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import { useConnection, usePlayer, trackTitle, trackArtist, formatDuration, type Track } from "@crateforge/core";
import { PALETTE, TV_FONT, FOCUS_RING } from "@/theme/palette";

export default function LibraryScreen() {
  const client = useConnection((s) => s.client);
  const router = useRouter();
  const setQueue = usePlayer((s) => s.setQueue);
  const [focusedId, setFocusedId] = useState<number | null>(null);

  const { data: tracks, isLoading, error } = useQuery({
    queryKey: ["tracks", "all"],
    queryFn: () => client!.listTracks({ limit: 500, sort: "name", order: "asc" }),
    enabled: !!client,
  });

  const handleSelect = useCallback(
    (track: Track, index: number) => {
      if (!tracks) return;
      setQueue(tracks, index);
      router.push("/player");
    },
    [tracks, setQueue, router],
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={PALETTE.teal} size="large" />
        <Text style={styles.loadingText}>ライブラリを読み込み中…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>ライブラリの取得に失敗しました</Text>
        <Text style={styles.errorDetail}>{String(error)}</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>ライブラリ</Text>
        <Text style={styles.headerCount}>{tracks?.length ?? 0} 曲</Text>
        <Pressable
          style={[styles.settingsBtn, focusedId === -1 && FOCUS_RING]}
          onFocus={() => setFocusedId(-1)}
          onBlur={() => setFocusedId(null)}
          onPress={() => router.push("/settings")}
        >
          <Text style={styles.settingsBtnText}>設定</Text>
        </Pressable>
      </View>
      <FlatList
        data={tracks}
        keyExtractor={(item) => String(item.trackId)}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            index={index}
            focused={focusedId === item.trackId}
            onFocus={() => setFocusedId(item.trackId)}
            onBlur={() => setFocusedId(null)}
            onPress={() => handleSelect(item, index)}
            client={client!}
          />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

interface TrackRowProps {
  track: Track;
  index: number;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onPress: () => void;
  client: NonNullable<ReturnType<typeof useConnection.getState>["client"]>;
}

function TrackRow({ track, focused, onFocus, onBlur, onPress, client }: TrackRowProps) {
  return (
    <Pressable
      style={[styles.row, focused && styles.rowFocused]}
      onFocus={onFocus}
      onBlur={onBlur}
      onPress={onPress}
    >
      <Image
        source={client.artworkSource(track.trackId)}
        style={styles.artwork}
        contentFit="cover"
      />
      <View style={styles.rowText}>
        <Text style={styles.trackName} numberOfLines={1}>
          {trackTitle(track)}
        </Text>
        <Text style={styles.trackSub} numberOfLines={1}>
          {trackArtist(track)}
          {track.album ? ` — ${track.album}` : ""}
        </Text>
      </View>
      <Text style={styles.duration}>{formatDuration(track.totalTimeMs)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: PALETTE.bg,
    gap: 16,
  },
  loadingText: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    marginTop: 16,
  },
  errorText: {
    fontSize: TV_FONT.md,
    color: "#E57373",
  },
  errorDetail: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 48,
    paddingVertical: 24,
    backgroundColor: PALETTE.surface,
    borderBottomWidth: 1,
    borderBottomColor: PALETTE.border,
  },
  headerTitle: {
    fontSize: TV_FONT.lg,
    fontWeight: "700",
    color: PALETTE.teal,
    flex: 1,
  },
  headerCount: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    marginRight: 24,
  },
  settingsBtn: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: PALETTE.border,
  },
  settingsBtnText: {
    fontSize: TV_FONT.sm,
    color: PALETTE.text,
  },
  list: {
    paddingVertical: 8,
    paddingHorizontal: 24,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingVertical: 16,
    marginVertical: 2,
    borderRadius: 8,
    backgroundColor: "transparent",
  },
  rowFocused: {
    backgroundColor: PALETTE.focusBg,
    borderWidth: 3,
    borderColor: PALETTE.teal,
  },
  artwork: {
    width: 72,
    height: 72,
    borderRadius: 4,
    backgroundColor: PALETTE.surface,
  },
  rowText: {
    flex: 1,
    marginLeft: 24,
    gap: 6,
  },
  trackName: {
    fontSize: TV_FONT.md,
    fontWeight: "600",
    color: PALETTE.text,
  },
  trackSub: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
  },
  duration: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    marginLeft: 24,
    fontVariant: ["tabular-nums"],
  },
});
