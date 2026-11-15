// アルバム画面。一覧（AlbumRow の縦リスト）と詳細（選択アルバムの曲一覧）を
// 1 ルート内の master/detail で切り替える。TV は flat ルート構成（album 詳細用の
// 個別ルートが無い）ため、選択状態をローカルに持って画面内で詳細へ切り替える。
//
// データ取得は core の閲覧フック（useAlbums / useAlbumTracks。mobile と共通）。
// 再生開始は mobile の onPressTrack パターンを踏襲し、
// usePlayer.setQueue でキューを差し替えて /player（Now Playing）へ遷移する。

import { useState } from "react";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet } from "react-native";

import {
  type Album,
  albumLabel,
  compareNamesUnknownLast,
  useAlbumTracks,
  useAlbums,
  usePlayer,
} from "@crateforge/core";
import { AlbumRow } from "@/components/library/AlbumRow";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

/** アルバム一覧の並び順: mobile と同じ名前の自然順（"Vol. 2" < "Vol. 10"）。不明なアルバムは末尾。 */
const byAlbumName = compareNamesUnknownLast((a: Album) => a.album);

/** useAlbums の select（参照を固定して、再描画のたびに並べ替え直さない）。 */
function sortAlbumsForTv(albums: Album[]): Album[] {
  return [...albums].sort(byAlbumName);
}

export default function AlbumsScreen() {
  const router = useRouter();
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);
  // 選択中アルバム（null=一覧表示 / 非null=詳細表示）。
  const [selected, setSelected] = useState<Album | null>(null);

  // アルバム一覧（distinct）。並びは mobile と同じ名前順（不明なアルバム末尾）。
  const albumsQuery = useAlbums({ select: sortAlbumsForTv });
  const albums = albumsQuery.data ?? [];

  // 選択アルバムの曲（disc→track 昇順、album 名は完全一致）。一覧と詳細を 1 画面で切り替えるので
  // 切り替え直後は前の結果を仮表示する（keepPrevious）。
  const albumName = selected ? selected.album : null;
  const tracksQuery = useAlbumTracks(albumName, { keepPrevious: true });
  const albumTracks = tracksQuery.data ?? [];

  // アルバム選択（不明なアルバム = 空名も詳細へ入れる）。
  const openAlbum = (album: Album) => {
    setSelected(album);
  };

  // 曲選択: アルバム全曲でキューを差し替え、その index から再生して Now Playing へ。
  const playTrack = (index: number) => {
    usePlayer.getState().setQueue(albumTracks, index);
    router.push("/player");
  };

  // 全曲再生: 先頭からアルバム全体をキューにして再生。
  const playAll = () => {
    if (albumTracks.length === 0) return;
    usePlayer.getState().setQueue(albumTracks, 0);
    router.push("/player");
  };

  // ---- 詳細表示（選択アルバムの曲一覧）----
  if (selected) {
    const title = albumLabel(selected.album);
    const subtitle = `${selected.albumArtist ? `${selected.albumArtist} ・ ` : ""}${albumTracks.length || selected.trackCount}曲`;
    return (
      <View style={styles.container}>
        <View style={styles.detailHeader}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
          <View style={styles.actions}>
            <Focusable
              onSelect={playAll}
              hasTVPreferredFocus
              style={styles.actionBtn}
              focusedStyle={styles.actionBtnFocused}
              accessibilityLabel="アルバムを再生"
            >
              <Text style={styles.actionLabel}>▶ 再生</Text>
            </Focusable>
            <Focusable
              onSelect={() => setSelected(null)}
              style={styles.actionBtn}
              focusedStyle={styles.actionBtnFocused}
              accessibilityLabel="アルバム一覧に戻る"
            >
              <Text style={styles.actionLabel}>← 戻る</Text>
            </Focusable>
          </View>
        </View>
        <LibraryList
          data={albumTracks}
          keyExtractor={(t) => String(t.trackId)}
          isLoading={tracksQuery.isLoading}
          isError={tracksQuery.isError}
          errorMessage="曲の読み込みに失敗しました"
          emptyMessage="このアルバムは空です"
          renderItem={({ item, index }) => (
            <TrackRow
              track={item}
              index={index + 1}
              active={currentTrackId === item.trackId}
              onSelect={() => playTrack(index)}
            />
          )}
        />
      </View>
    );
  }

  // ---- 一覧表示（アルバム）----
  return (
    <View style={styles.container}>
      <Text style={styles.title}>アルバム</Text>
      <LibraryList
        data={albums}
        keyExtractor={(a) => a.album || `__noalbum__${a.sampleTrackId}`}
        isLoading={albumsQuery.isLoading}
        isError={albumsQuery.isError}
        errorMessage="アルバムの読み込みに失敗しました"
        emptyMessage="アルバムがありません"
        renderItem={({ item, index }) => (
          <AlbumRow
            album={item}
            hasTVPreferredFocus={index === 0}
            onSelect={() => openAlbum(item)}
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
  detailHeader: {
    marginBottom: 16,
  },
  subtitle: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    marginTop: -12,
    marginBottom: 20,
  },
  actions: {
    flexDirection: "row",
    gap: 20,
  },
  actionBtn: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: FOCUS_RING.borderRadius,
    backgroundColor: PALETTE.surface,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  actionBtnFocused: {
    ...FOCUS_RING,
    backgroundColor: PALETTE.focusBg,
  },
  actionLabel: {
    fontSize: TV_FONT.sm,
    fontWeight: "700",
    color: PALETTE.text,
  },
});
