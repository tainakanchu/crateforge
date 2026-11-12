// Playlists タブ。フォルダ階層のルート項目だけを縦に一覧する。
// 各行: 名前（太字）+ 種別/曲数 + アイコン。フォルダはフォルダ画面へ、プレイリストは詳細へ遷移。
// trackCount での絞り込みはしない（空 / スマートも表示）。
// オフライン時はダウンロード済みプレイリストを一覧し、タップで詳細へ遷移できる。

import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { type DownloadedPlaylist, type Playlist, useConnection, useDownloads, describeApiError } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { usePlaylists } from "@/features/browse/hooks";
import { rootItems } from "@/features/browse/playlistTree";
import PlaylistRow from "@/features/browse/PlaylistRow";

export default function PlaylistsScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  const query = usePlaylists();

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
      {/* オフライン中を示すバナー */}
      <View style={styles.offlineBanner}>
        <Ionicons name="cloud-offline-outline" size={15} color={PALETTE.textDim} />
        <Text style={styles.offlineBannerText}>
          {rows.length > 0
            ? `サーバー未接続 ・ 保存済み ${rows.length}件`
            : "サーバー未接続"}
        </Text>
      </View>

      {rows.length === 0 ? (
        <>
          <EmptyView
            message="オフライン保存されたプレイリストはありません"
            icon="cloud-offline-outline"
          />
          <View style={styles.connectActions}>
            <Pressable
              onPress={() => router.push("/connect")}
              accessibilityRole="button"
              accessibilityLabel="サーバーに接続"
              style={({ pressed }) => [styles.connectBtn, pressed && styles.pressed]}
            >
              <Ionicons name="wifi" size={18} color={BRAND.accentText} />
              <Text style={styles.connectBtnText}>サーバーに接続</Text>
            </Pressable>
          </View>
        </>
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
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
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
  connectActions: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  connectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.accent,
  },
  connectBtnText: {
    color: BRAND.accentText,
    fontSize: 15,
    fontWeight: "700",
  },
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
