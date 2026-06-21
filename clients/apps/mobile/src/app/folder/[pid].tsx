// フォルダ詳細。指定フォルダ（persistentId）の直下にある子（フォルダ/プレイリスト）を一覧する。
// 子フォルダはさらに /folder/[childPid] へ再帰し、プレイリストは /playlist/[id] へ遷移する。
// ヘッダにはフォルダ名（一覧から persistentId で引く）を表示する。

import { useMemo } from "react";
import { FlatList, Text, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { type Playlist, useConnection } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { usePlaylists } from "@/features/browse/hooks";
import { childrenOf } from "@/features/browse/playlistTree";
import PlaylistRow from "@/features/browse/PlaylistRow";

export default function FolderScreen() {
  const router = useRouter();
  const { pid } = useLocalSearchParams<{ pid: string }>();
  const parentPid = decodeURIComponent(pid ?? "");
  const client = useConnection((s) => s.client);
  const query = usePlaylists();

  const all = query.data ?? [];

  // このフォルダ自身（名前表示用）と直下の子。
  const folder = useMemo(
    () => all.find((p) => (p.persistentId ?? String(p.playlistId)) === parentPid),
    [all, parentPid],
  );
  const rows = useMemo(() => childrenOf(all, parentPid), [all, parentPid]);

  const title = folder?.name ?? "フォルダ";

  const onPress = (p: Playlist) => {
    if (p.isFolder) {
      const childPid = p.persistentId ?? String(p.playlistId);
      router.push(`/folder/${encodeURIComponent(childPid)}`);
    } else {
      router.push(`/playlist/${p.playlistId}`);
    }
  };

  return (
    <Screen edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
      </View>

      {!client ? (
        <EmptyView message="サーバーに接続してください" icon="wifi-outline" />
      ) : query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <ErrorView message={errorText(query.error)} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyView message="このフォルダは空です" icon="folder-outline" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(p) => String(p.playlistId)}
          renderItem={({ item }: { item: Playlist }) => (
            <PlaylistRow playlist={item} onPress={() => onPress(item)} />
          )}
          contentContainerStyle={styles.listContent}
        />
      )}
    </Screen>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "読み込みに失敗しました";
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: "700",
  },
  listContent: {
    paddingBottom: 96,
  },
});
