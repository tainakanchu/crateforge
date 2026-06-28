// アルバム画面。一覧（AlbumRow の縦リスト）と詳細（選択アルバムの曲一覧）を
// 1 ルート内の master/detail で切り替える。TV は flat ルート構成（album 詳細用の
// 個別ルートが無い）ため、選択状態をローカルに持って画面内で詳細へ切り替える。
//
// データ取得は core の専用フックが無いため songs.tsx と同様に React Query で
// client.albums() / client.listTracks({ album }) を包む（mobile の useAlbums /
// useAlbumTracks と同型）。再生開始は mobile の onPressTrack パターンを踏襲し、
// usePlayer.setQueue でキューを差し替えて /player（Now Playing）へ遷移する。

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet } from "react-native";

import { type Album, type Track, useConnection, usePlayer } from "@crateforge/core";
import { AlbumRow } from "@/components/library/AlbumRow";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { Focusable } from "@/components/focus";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

/** 大規模ライブラリでも全件取得（mobile の BROWSE_LIMIT と同値）。 */
const BROWSE_LIMIT = 100000;

/**
 * アルバムの並び順比較（mobile compareAlbums の簡易版）。
 * 「アルバムアーティスト（無ければアルバム名）→ アルバム名」の昇順。
 * /api/albums は year を返さないため年順は省略（安定ソートで十分）。
 */
function compareAlbums(a: Album, b: Album): number {
  const byArtist = (a.albumArtist ?? a.album).localeCompare(b.albumArtist ?? b.album, undefined, {
    sensitivity: "base",
  });
  if (byArtist !== 0) return byArtist;
  return a.album.localeCompare(b.album, undefined, { sensitivity: "base" });
}

/** disc 番号 → トラック番号 の収録順比較。 */
function byDiscTrack(a: Track, b: Track): number {
  return (a.discNumber ?? 0) - (b.discNumber ?? 0) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0);
}

export default function AlbumsScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);
  // 選択中アルバム（null=一覧表示 / 非null=詳細表示）。
  const [selected, setSelected] = useState<Album | null>(null);

  // アルバム一覧（distinct）。client 未接続時は enabled:false で待機。
  const albumsQuery = useQuery<Album[], Error, Album[]>({
    queryKey: ["albums"],
    enabled: !!client,
    queryFn: () => client!.albums(),
    placeholderData: keepPreviousData,
    select: (albums) => [...albums].sort(compareAlbums),
  });
  const albums = albumsQuery.data ?? [];

  // 選択アルバムの曲（disc→track 昇順）。album 名が空のときは取得しない。
  const albumName = selected?.album || null;
  const tracksQuery = useQuery<Track[], Error, Track[]>({
    queryKey: ["album-tracks", albumName],
    enabled: !!client && !!albumName,
    queryFn: ({ signal }) => client!.listTracks({ album: albumName!, limit: BROWSE_LIMIT }, signal),
    placeholderData: keepPreviousData,
    select: (tracks) => [...tracks].sort(byDiscTrack),
  });
  const albumTracks = tracksQuery.data ?? [];

  // アルバム選択: 空アルバム名は詳細に入れない（mobile と同じガード）。
  const openAlbum = (album: Album) => {
    if (!album.album) return;
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
    const title = selected.album || "アルバム";
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
