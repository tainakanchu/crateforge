// 曲一覧画面。core の useTracks（mobile と共通の閲覧フック）で全曲を取得し、
// 共有の TrackRow を縦リスト（LibraryList）で表示する。行を選ぶと usePlayer.setQueue で
// キューを差し替え、/player（Now Playing）へ遷移して再生を始める。
// albums/artists/playlists/search 画面も同じく core の閲覧フックと TrackRow/LibraryList を使う。

import { useRouter } from "expo-router";
import { View, Text, StyleSheet } from "react-native";

import { BROWSE_LIMIT, usePlayer, useTracks } from "@crateforge/core";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { PALETTE, TV_FONT, TV_LAYOUT } from "@/theme/palette";

export default function SongsScreen() {
  const router = useRouter();
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // 全曲を名前昇順で取得。未接続時は取得せず待機（Gate が /connect へ誘導）。
  const query = useTracks({ limit: BROWSE_LIMIT, sort: "name", order: "asc" });

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
