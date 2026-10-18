// ダウンロード管理画面。保存済み曲を一覧し、行タップで再生・削除ボタンで個別削除。
// ヘッダに合計サイズ/件数と「すべて削除」を表示。空ならガイド。
// Android で再生できない原本（AIFF/CAF）の行には「AAC で再ダウンロード」を出す（design D7）。

import { useMemo } from "react";
import { FlatList, Platform, Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type DownloadEntry, useConnection, useDownloads, usePlayer } from "@crateforge/core";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import { EmptyView } from "@/components/StateViews";
import { PALETTE } from "@/constants/brand";
import { formatBytes } from "@/features/offline/format";
import { AAC_REDOWNLOAD_QUALITY, androidUnsupportedOriginal } from "@/features/offline/unsupportedFormat";

export default function DownloadsScreen() {
  const entries = useDownloads((s) => s.entries);
  const playlists = useDownloads((s) => s.playlists);
  const removeDownload = useDownloads((s) => s.removeDownload);
  const clearAll = useDownloads((s) => s.clearAll);
  const redownloadTrack = useDownloads((s) => s.redownloadTrack);
  const downloading = useDownloads((s) => s.downloading);
  // 再ダウンロードはサーバー接続中のみ可能。
  const online = useConnection((s) => s.client != null);

  // 新しい順に並べた配列に変換（永続データは Record なので毎回整列する）。
  const list = useMemo(
    () => Object.values(entries).sort((a, b) => b.createdAt - a.createdAt),
    [entries],
  );
  const totalBytes = useMemo(
    () => list.reduce((sum, e) => sum + (e.bytes || 0), 0),
    [list],
  );
  const pinnedPlaylists = useMemo(
    () =>
      Object.values(playlists)
        .filter((playlist) => playlist.pinned === true)
        .map((playlist) => ({
          ...playlist,
          bytes: [...new Set(playlist.trackIds)].reduce(
            (sum, trackId) => sum + (entries[trackId]?.bytes || 0),
            0,
          ),
        }))
        .sort((a, b) => b.createdAt - a.createdAt),
    [playlists, entries],
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

      {list.length === 0 && pinnedPlaylists.length === 0 ? (
        <EmptyView
          message="ダウンロード済みの曲はありません"
          icon="cloud-download-outline"
        />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(e: DownloadEntry) => String(e.trackId)}
          ListHeaderComponent={
            pinnedPlaylists.length > 0 ? (
              <View style={styles.pinnedSection}>
                <Text style={styles.sectionHeading}>ピン留め済みプレイリスト</Text>
                {pinnedPlaylists.map((playlist) => (
                  <View key={playlist.playlistId} style={styles.playlistRow}>
                    <View style={styles.playlistText}>
                      <Text style={styles.playlistName} numberOfLines={1}>
                        {playlist.name}
                      </Text>
                      <Text style={styles.playlistMeta}>{playlist.trackIds.length}曲</Text>
                    </View>
                    <Text style={styles.bytes}>{formatBytes(playlist.bytes)}</Text>
                  </View>
                ))}
                {list.length > 0 ? (
                  <Text style={styles.sectionHeading}>ダウンロード済みの曲</Text>
                ) : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            pinnedPlaylists.length > 0 ? (
              <EmptyView message="ダウンロード済みの曲はありません" icon="cloud-download-outline" />
            ) : null
          }
          renderItem={({ item, index }) => {
            const unsupported = androidUnsupportedOriginal(item, Platform.OS);
            const row = (
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
            );
            if (unsupported == null) return row;
            const busy = downloading[item.trackId] === true;
            return (
              <View>
                {row}
                <View style={styles.unsupportedRow}>
                  <Text style={styles.unsupportedText} numberOfLines={2}>
                    {online
                      ? `${unsupported} はこの端末で再生できません`
                      : `${unsupported} はこの端末で再生できません（接続中に再ダウンロードできます）`}
                  </Text>
                  <Pressable
                    onPress={() => void redownloadTrack(item.trackId, AAC_REDOWNLOAD_QUALITY)}
                    disabled={!online || busy}
                    accessibilityRole="button"
                    accessibilityLabel="AAC で再ダウンロード"
                    accessibilityState={{ disabled: !online || busy, busy }}
                    style={({ pressed }) => [
                      styles.redownloadBtn,
                      (!online || busy) && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.redownloadText}>
                      {busy ? "再ダウンロード中…" : "AAC で再ダウンロード"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
          contentContainerStyle={styles.listContent}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  listContent: {
    // ミニプレイヤー（全画面常時表示）に最下部の行が隠れないよう余白を確保。
    paddingBottom: 96,
  },
  pinnedSection: {
    paddingTop: 4,
    paddingBottom: 8,
  },
  sectionHeading: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  playlistRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PALETTE.border,
  },
  playlistText: {
    flex: 1,
    minWidth: 0,
  },
  playlistName: {
    color: PALETTE.text,
    fontSize: 15,
    fontWeight: "600",
  },
  playlistMeta: {
    color: PALETTE.textFaint,
    fontSize: 12,
    marginTop: 2,
  },
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
  disabled: {
    opacity: 0.4,
  },
  unsupportedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  unsupportedText: {
    flex: 1,
    minWidth: 0,
    color: PALETTE.textDim,
    fontSize: 12,
  },
  redownloadBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  redownloadText: {
    color: PALETTE.accent,
    fontSize: 12,
    fontWeight: "600",
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
