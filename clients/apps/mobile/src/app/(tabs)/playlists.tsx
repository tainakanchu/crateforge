// Playlists タブ。フォルダ階層のルート項目だけを縦に一覧する。
// 各行: 名前（太字）+ 種別/曲数 + アイコン。フォルダはフォルダ画面へ、プレイリストは詳細へ遷移。
// trackCount での絞り込みはしない（空 / スマートも表示）。
// オフライン時はダウンロード済みプレイリストを一覧し、タップで詳細へ遷移できる。

import { useMemo } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { type DownloadedPlaylist, type Playlist, useConnection, useDownloads, describeApiError } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import ConnectionNotice from "@/components/ConnectionNotice";
import { usePlaylists } from "@/features/browse/hooks";
import { rootItems } from "@/features/browse/playlistTree";
import PlaylistRow from "@/features/browse/PlaylistRow";
import { LIGHT_LIST_FRESH_MS, usePullToRefresh, useRefetchStaleOnFocus } from "@/hooks/use-refresh";

// タブに戻ったら（このタブの）プレイリスト一覧だけ、10 秒以上経っていれば取り直す（round-3 N5）。
const PLAYLISTS_FOCUS_TARGETS = [{ queryKey: ["playlists"], freshMs: LIGHT_LIST_FRESH_MS }] as const;

export default function PlaylistsScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  const query = usePlaylists();
  // プル更新 + タブに戻ったときの再取得（stale のみ）。
  const { refreshing, onRefresh } = usePullToRefresh(query.refetch);
  useRefetchStaleOnFocus(PLAYLISTS_FOCUS_TARGETS);

  // 階層のルート項目だけを表示する。空のプレイリスト・スマートプレイリストも隠さない
  // （スマートの件数は評価結果に依存するため 0 でも表示する）。
  const rows = useMemo(() => rootItems(query.data ?? []), [query.data]);

  const onPress = (p: Playlist) => {
    if (p.isFolder) {
      const pid = p.persistentId ?? String(p.playlistId);
      router.push(`/folder/${encodeURIComponent(pid)}`);
    } else {
      router.push(`/playlist/${p.playlistId}`);
    }
  };

  // オフライン時はダウンロード済みプレイリストを表示する。
  if (!client) {
    return <OfflinePlaylists />;
  }

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={(p) => String(p.playlistId)}
        renderItem={({ item }: { item: Playlist }) => (
          <PlaylistRow playlist={item} onPress={() => onPress(item)} />
        )}
        ListEmptyComponent={
          query.isLoading ? (
            <Loading />
          ) : query.isError ? (
            <ErrorView message={errorText(query.error)} onRetry={() => query.refetch()} />
          ) : (
            <EmptyView message="プレイリストがありません" icon="list-outline" />
          )
        }
        contentContainerStyle={rows.length === 0 ? styles.emptyContent : styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PALETTE.accent} colors={[PALETTE.accent]} />
        }
      />
    </Screen>
  );
}

/**
 * オフライン時のプレイリスト画面。
 * ダウンロード済みプレイリストを一覧し、タップで詳細へ遷移する。
 * 0件なら接続導線付きの空表示を出す。
 */
function OfflinePlaylists() {
  const router = useRouter();
  const playlists = useDownloads((s) => s.playlists);

  // オブジェクトを配列に変換し、保存日時の新しい順に並べる。
  const rows = useMemo(
    () =>
      Object.values(playlists).sort((a, b) => b.createdAt - a.createdAt),
    [playlists],
  );

  return (
    <Screen>
      {/* 未接続の理由 1 行 + 復帰導線（トークン再入力 / 再試行 / 接続画面へ）。 */}
      <ConnectionNotice suffix={rows.length > 0 ? `保存済み ${rows.length}件` : null} />

      {rows.length === 0 ? (
        <EmptyView
          message="オフライン保存されたプレイリストはありません"
          icon="cloud-offline-outline"
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(p) => String(p.playlistId)}
          renderItem={({ item }: { item: DownloadedPlaylist }) => (
            <OfflinePlaylistRow
              playlist={item}
              onPress={() => router.push(`/playlist/${item.playlistId}`)}
            />
          )}
          contentContainerStyle={styles.listContent}
        />
      )}
    </Screen>
  );
}

/** オフラインプレイリストの1行。名前・曲数・アイコンを表示する。 */
function OfflinePlaylistRow({
  playlist,
  onPress,
}: {
  playlist: DownloadedPlaylist;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={playlist.name}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Ionicons name="list" size={20} color={PALETTE.textDim} style={styles.rowIcon} />
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {playlist.name}
        </Text>
        <Text style={styles.rowMeta}>{playlist.trackIds.length}曲</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={PALETTE.textFaint} />
    </Pressable>
  );
}

function errorText(e: unknown): string {
  return describeApiError(e, { action: "読み込み" });
}

const styles = StyleSheet.create({
  listContent: { paddingTop: 8, paddingBottom: 96 },
  emptyContent: { flexGrow: 1 },
  pressed: {
    opacity: 0.7,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PALETTE.border,
  },
  rowIcon: {
    marginRight: 12,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    color: PALETTE.text,
    fontSize: 15,
    fontWeight: "600",
  },
  rowMeta: {
    color: PALETTE.textFaint,
    fontSize: 13,
    marginTop: 2,
  },
});
