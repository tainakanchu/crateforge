// Playlists タブ。フォルダ階層のルート項目だけを縦に一覧する。
// 各行: 名前（太字）+ 種別/曲数 + アイコン。フォルダはフォルダ画面へ、プレイリストは詳細へ遷移。
// フォルダは子を含むので trackCount で落とさない。空のプレイリスト（非フォルダ）だけ間引く。

import { useMemo } from "react";
import { FlatList } from "react-native";
import { useRouter } from "expo-router";

import { type Playlist, useConnection } from "@crateforge/core";
import Screen from "@/components/Screen";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { usePlaylists } from "@/features/browse/hooks";
import { rootItems } from "@/features/browse/playlistTree";
import PlaylistRow from "@/features/browse/PlaylistRow";

export default function PlaylistsScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  const query = usePlaylists();

  // 階層のルート項目だけを表示する。フォルダは中身を持つので残し、
  // 空の通常プレイリスト（trackCount 0）だけノイズとして間引く。
  const rows = useMemo(() => {
    const all = query.data ?? [];
    return rootItems(all).filter((p) => (p.isFolder ? true : p.trackCount > 0));
  }, [query.data]);

  const onPress = (p: Playlist) => {
    if (p.isFolder) {
      const pid = p.persistentId ?? String(p.playlistId);
      router.push(`/folder/${encodeURIComponent(pid)}`);
    } else {
      router.push(`/playlist/${p.playlistId}`);
    }
  };

  if (!client) {
    return (
      <Screen>
        <EmptyView message="サーバーに接続してください" icon="wifi-outline" />
      </Screen>
    );
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "読み込みに失敗しました";
}

const styles = {
  listContent: { paddingTop: 8, paddingBottom: 96 },
  emptyContent: { flexGrow: 1 },
} as const;
