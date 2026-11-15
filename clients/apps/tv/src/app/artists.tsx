// アーティスト一覧画面（10ft UI / D-pad 操作前提・マスターディテール 2 ペイン）。
//
// 左ペイン(マスター): core の useArtists で取得したアーティスト一覧（ArtistRow）。
//   - 行にフォーカスが当たると（onFocus）右ペインをそのアーティストの詳細に切り替えてプレビュー。
//   - 行を決定（onSelect）すると、そのアーティストの全曲を setQueue して /player へ（即再生）。
// 右ペイン(ディテール): 選択中アーティストの全曲（TrackRow）。
//   - ヘッダに「すべて再生」ボタン。曲行を決定するとその位置から全曲をキューにして再生。
//
// データ取得は core の閲覧フック（useArtists / useArtistTracks。mobile と共通）。
// 再生開始は songs.tsx と同じ usePlayer.setQueue → /player パターン。

import { useState } from "react";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet } from "react-native";

import {
  artistLabel,
  useArtistTracks,
  useArtists,
  usePlayer,
  useSettings,
} from "@crateforge/core";
import { ArtistRow } from "@/components/library/ArtistRow";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

export default function ArtistsScreen() {
  const router = useRouter();
  // アーティストの束ね方（artist / albumArtist）。core 設定ストアと共有。
  const grouping = useSettings((s) => s.artistGrouping);
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // 詳細ペインに表示するアーティスト名。null のときは一覧先頭にフォールバックする。
  const [selected, setSelected] = useState<string | null>(null);

  // アーティスト一覧（サーバ側 /api/artists で集計）。
  const artistsQuery = useArtists({ grouping });
  const artists = artistsQuery.data ?? [];

  // フォーカス未確定でも先頭アーティストを既定選択にして詳細ペインを埋める。
  const activeArtist = selected ?? artists[0]?.artist ?? null;

  // 選択中アーティストの全曲（grouping に応じて artist / albumArtist でフィルタ）。
  const tracksQuery = useArtistTracks(activeArtist, { grouping });
  const tracks = tracksQuery.data ?? [];

  // 曲行選択: 選択中アーティストの全曲でキューを差し替え、その index から再生して Now Playing へ。
  const onPlayTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  // アーティスト行の決定 / 「すべて再生」: そのアーティストの全曲を頭から再生。
  const onPlayAll = () => {
    if (tracks.length === 0) return;
    usePlayer.getState().setQueue(tracks, 0);
    router.push("/player");
  };

  // 詳細ペインのヘッダ（アーティスト名 + 曲数 + すべて再生ボタン）。
  const detailHeader =
    activeArtist == null ? null : (
      <View style={styles.detailHeader}>
        <Text style={styles.detailTitle} numberOfLines={1}>
          {/* 不明なアーティスト（artist: ""）もラベルで出す。曲は ?artist=（空）で引ける。 */}
          {artistLabel(activeArtist)}
        </Text>
        <Text style={styles.detailCount}>{tracks.length}曲</Text>
        {tracks.length > 0 ? (
          <Focusable
            onSelect={onPlayAll}
            style={styles.playButton}
            accessibilityLabel="すべて再生"
          >
            <Text style={styles.playButtonLabel}>すべて再生</Text>
          </Focusable>
        ) : null}
      </View>
    );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>アーティスト</Text>

      <View style={styles.panes}>
        {/* 左: アーティスト一覧（マスター） */}
        <View style={styles.master}>
          <LibraryList
            data={artists}
            keyExtractor={(a) => `${a.artist}-${a.sampleTrackId}`}
            isLoading={artistsQuery.isLoading}
            isError={artistsQuery.isError}
            errorMessage="アーティストの読み込みに失敗しました"
            emptyMessage="アーティストがいません"
            renderItem={({ item, index }) => (
              <ArtistRow
                artist={item}
                active={activeArtist === item.artist}
                hasTVPreferredFocus={index === 0}
                onFocus={() => setSelected(item.artist)}
                onSelect={onPlayAll}
              />
            )}
          />
        </View>

        {/* 右: 選択中アーティストの全曲（ディテール） */}
        <View style={styles.detail}>
          {activeArtist == null ? (
            <View style={styles.detailEmpty}>
              <Text style={styles.detailEmptyText}>アーティストを選択してください</Text>
            </View>
          ) : (
            <LibraryList
              data={tracks}
              keyExtractor={(t) => String(t.trackId)}
              isLoading={tracksQuery.isLoading}
              isError={tracksQuery.isError}
              errorMessage="曲の読み込みに失敗しました"
              emptyMessage="このアーティストの曲はありません"
              ListHeaderComponent={detailHeader}
              renderItem={({ item, index }) => (
                <TrackRow
                  track={item}
                  active={currentTrackId === item.trackId}
                  onSelect={() => onPlayTrack(index)}
                />
              )}
            />
          )}
        </View>
      </View>
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
  panes: {
    flex: 1,
    flexDirection: "row",
    gap: 32,
  },
  master: {
    width: 460,
    flexShrink: 0,
  },
  detail: {
    flex: 1,
    minWidth: 0,
  },
  detailEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  detailEmptyText: {
    fontSize: TV_FONT.md,
    color: PALETTE.textSub,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 16,
  },
  detailTitle: {
    flexShrink: 1,
    fontSize: TV_FONT.md,
    fontWeight: "700",
    color: PALETTE.text,
  },
  detailCount: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    flexShrink: 0,
  },
  playButton: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: FOCUS_RING.borderRadius,
    backgroundColor: PALETTE.navActive,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
    flexShrink: 0,
  },
  playButtonLabel: {
    fontSize: TV_FONT.sm,
    fontWeight: "700",
    color: PALETTE.text,
  },
});
