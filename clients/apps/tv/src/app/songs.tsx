// 曲一覧画面。core の ApiClient.listTracks（useConnection().client 経由）で全曲を取得し、
// 共有の TrackRow を縦リスト（LibraryList）で表示する。行を選ぶと usePlayer.setQueue で
// キューを差し替え、/player（Now Playing）へ遷移して再生を始める。
//
// データ取得は core の専用フックが無いため、mobile の useTracks と同じ要領で
// client.listTracks を React Query で包む（QueryClientProvider は _layout.tsx に既設）。
// 後続の albums/artists/playlists/search 画面はこのパターンと TrackRow/LibraryList を流用する。

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet } from "react-native";

import { type Track, useConnection, usePlayer } from "@crateforge/core";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { PALETTE, TV_FONT, TV_LAYOUT } from "@/theme/palette";

/** 大規模ライブラリでも全件取得（mobile の BROWSE_LIMIT と同値）。 */
const BROWSE_LIMIT = 100000;

export default function SongsScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // 全曲を名前昇順で取得。client 未接続時は enabled:false で待機（Gate が /connect へ誘導）。
  const query = useQuery<Track[]>({
    queryKey: ["tracks", { limit: BROWSE_LIMIT, sort: "name", order: "asc" }],
    enabled: !!client,
    queryFn: ({ signal }) =>
      client!.listTracks({ limit: BROWSE_LIMIT, sort: "name", order: "asc" }, signal),
    placeholderData: keepPreviousData,
  });

  const tracks = query.data ?? [];

  // 行選択: キューを全曲で差し替え、その index から再生して Now Playing へ。
  const onSelect = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>曲</Text>
      <LibraryList
        data={tracks}
        keyExtractor={(t) => String(t.trackId)}
        isLoading={query.isLoading}
        isError={query.isError}
        errorMessage="曲の読み込みに失敗しました"
        emptyMessage="曲がありません"
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            active={currentTrackId === item.trackId}
            hasTVPreferredFocus={index === 0}
            onSelect={() => onSelect(index)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.bg,
    paddingHorizontal: TV_LAYOUT.contentPaddingH,
    paddingVertical: TV_LAYOUT.contentPaddingV,
  },
  title: {
    fontSize: TV_FONT.lg,
    fontWeight: "700",
    color: PALETTE.teal,
    marginBottom: 24,
  },
});
