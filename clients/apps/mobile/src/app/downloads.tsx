// ダウンロード管理画面。保存済み曲を一覧し、行タップで再生・削除ボタンで個別削除。
// ヘッダに合計サイズ/件数と「すべて削除」を表示。空ならガイド。

import { useMemo } from "react";
import { FlatList, Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type DownloadEntry, useDownloads, usePlayer } from "@crateforge/core";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import { EmptyView } from "@/components/StateViews";
import { PALETTE } from "@/constants/brand";
import { formatBytes } from "@/features/offline/format";

export default function DownloadsScreen() {
  const entries = useDownloads((s) => s.entries);
  const removeDownload = useDownloads((s) => s.removeDownload);
  const clearAll = useDownloads((s) => s.clearAll);

  // 新しい順に並べた配列に変換（永続データは Record なので毎回整列する）。
  const list = useMemo(
    () => Object.values(entries).sort((a, b) => b.createdAt - a.createdAt),
    [entries],
  );
  const totalBytes = useMemo(
    () => list.reduce((sum, e) => sum + (e.bytes || 0), 0),
    [list],
  );

  // 一覧の曲をキューに積んで、タップ位置から再生する。
  function playFrom(index: number) {
    const tracks = list.map((e) => e.track);
    usePlayer.getState().setQueue(tracks, index);
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.heading}>ダウンロード</Text>
        <Text style={styles.subline}>
          {list.length}曲 ・ {formatBytes(totalBytes)}
        </Text>
        {list.length > 0 ? (
          <Pressable
            onPress={() => void clearAll()}
            accessibilityRole="button"
            accessibilityLabel="すべて削除"
            style={({ pressed }) => [styles.clearBtn, pressed && styles.pressed]}
          >
            <Ionicons name="trash-outline" size={16} color={PALETTE.danger} />
            <Text style={styles.clearText}>すべて削除</Text>
          </Pressable>
        ) : null}
      </View>

      {list.length === 0 ? (
        <EmptyView
          message="ダウンロード済みの曲はありません"
          icon="cloud-download-outline"
        />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(e: DownloadEntry) => String(e.trackId)}
          renderItem={({ item, index }) => (
            <TrackRow
              track={item.track}
              onPress={() => playFrom(index)}
              trailing={
                <View style={styles.trailing}>
                  <Text style={styles.bytes}>{formatBytes(item.bytes)}</Text>
                  <IconButton
                    name="trash-outline"
                    color={PALETTE.danger}
                    size={20}
                    accessibilityLabel="削除"
                    onPress={() => void removeDownload(item.trackId)}
                  />
                </View>
              }
            />
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 4,
  },
  heading: {
    color: PALETTE.text,
    fontSize: 28,
    fontWeight: "700",
  },
  subline: {
    color: PALETTE.textDim,
    fontSize: 14,
  },
  clearBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  clearText: {
    color: PALETTE.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.7,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bytes: {
    color: PALETTE.textFaint,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
