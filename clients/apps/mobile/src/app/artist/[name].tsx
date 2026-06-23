// アーティスト詳細。アーティスト名 + アルバム一覧（主役）+ 全曲リスト（下に併置）。
// アルバムは albumArtist 順にソート。タップでアルバム詳細へ。曲はその位置からアーティスト全体をキューにして再生する。

import { useMemo } from "react";
import { FlatList, Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { type Album, type Track, useConnection, usePlayer, useDownloads, useSettings, trackArtist, trackAlbumArtist } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import AlbumRow from "@/features/browse/AlbumRow";
import DownloadButton from "@/components/DownloadButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { useArtistTracks, useArtistAlbums } from "@/features/browse/hooks";

// アルバム一覧と全曲リストを 1 本の FlatList に流すための行ユニオン。
// 見出し / アルバム行 / 曲行を判別して renderItem を切り替える。
type Row =
  | { kind: "header"; key: string; title: string }
  | { kind: "album"; key: string; album: Album }
  | { kind: "track"; key: string; track: Track; trackIndex: number };

export default function ArtistScreen() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name: string }>();
  const artist = name ? decodeURIComponent(name) : "";
  const client = useConnection((s) => s.client);
  const artistGrouping = useSettings((s) => s.artistGrouping);

  // アルバム一覧（オンライン=全曲キャッシュ／オフライン=DL 済みから導出）。
  const albums = useArtistAlbums(artist || null, artistGrouping);

  // 全曲（オンライン）。オフライン時は DL 済み entries からアーティストで絞る。
  const query = useArtistTracks(artist || null, artistGrouping);
  const entries = useDownloads((s) => s.entries);
  const offlineTracks = useMemo(() => {
    if (client || !artist) return [] as Track[];
    const nameOf = artistGrouping === "albumArtist" ? trackAlbumArtist : trackArtist;
    return Object.values(entries)
      .map((e) => e.track)
      .filter((t) => nameOf(t) === artist)
      .sort(
        (a, b) =>
          (a.album ?? "").localeCompare(b.album ?? "", undefined, { sensitivity: "base" }) ||
          (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
          (a.trackNumber ?? 0) - (b.trackNumber ?? 0),
      );
  }, [client, artist, entries, artistGrouping]);
  const tracks = client ? (query.data ?? []) : offlineTracks;

  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  const onPressTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  const onPlayAll = () => {
    if (tracks.length === 0) return;
    usePlayer.getState().setQueue(tracks, 0);
    router.push("/player");
  };

  // アルバム → 全曲の順でフラットな行配列にする。空セクションは見出しごと省く。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (albums.length > 0) {
      out.push({ kind: "header", key: "h-albums", title: "アルバム" });
      albums.forEach((album, i) => out.push({ kind: "album", key: `a-${album.album}-${i}`, album }));
    }
    if (tracks.length > 0) {
      out.push({ kind: "header", key: "h-tracks", title: "全曲" });
      tracks.forEach((track, i) =>
        out.push({ kind: "track", key: `t-${track.trackId}`, track, trackIndex: i }),
      );
    }
    return out;
  }, [albums, tracks]);

  const headerLabel =
    albums.length > 0
      ? `${albums.length}枚のアルバム${tracks.length > 0 ? ` ・ ${tracks.length}曲` : ""}`
      : tracks.length > 0
        ? `${tracks.length}曲`
        : "";

  return (
    <Screen edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={2}>
            {artist || "アーティスト"}
          </Text>
          {headerLabel ? <Text style={styles.count}>{headerLabel}</Text> : null}
        </View>
      </View>

      {/* オフライン時のバナー */}
      {!client ? (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={15} color={PALETTE.textDim} />
          <Text style={styles.offlineBannerText}>オフライン再生</Text>
        </View>
      ) : null}

      {tracks.length > 0 ? (
        <View style={styles.actions}>
          <Pressable
            onPress={onPlayAll}
            accessibilityRole="button"
            accessibilityLabel="再生"
            style={({ pressed }) => [styles.playButton, pressed && styles.playPressed]}
          >
            <Ionicons name="play" size={18} color={BRAND.accentText} />
            <Text style={styles.playLabel}>再生</Text>
          </Pressable>
        </View>
      ) : null}

      {client && query.isLoading ? (
        <Loading />
      ) : client && query.isError ? (
        <ErrorView message={errorText(query.error)} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyView
          message={client ? "このアーティストの曲はありません" : "このアーティストのオフライン保存はありません"}
          icon={client ? "person-outline" : "cloud-offline-outline"}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }: { item: Row }) => {
            if (item.kind === "header") {
              return <Text style={styles.sectionHeader}>{item.title}</Text>;
            }
            if (item.kind === "album") {
              return (
                <AlbumRow
                  album={item.album}
                  onPress={() => {
                    // 空アルバム名では遷移しない（/album/ 空セグメント＝クラッシュの防御）。
                    if (!item.album.album) return;
                    router.push(`/album/${encodeURIComponent(item.album.album)}`);
                  }}
                />
              );
            }
            return (
              <TrackRow
                track={item.track}
                index={item.trackIndex + 1}
                active={currentTrackId === item.track.trackId}
                onPress={() => onPressTrack(item.trackIndex)}
                onLongPress={() => usePlayer.getState().enqueueNext(item.track)}
                trailing={<DownloadButton track={item.track} />}
              />
            );
          }}
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: PALETTE.text,
    fontSize: 22,
    fontWeight: "700",
  },
  count: {
    color: PALETTE.textFaint,
    fontSize: 13,
    marginTop: 2,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  playButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: PALETTE.accent,
  },
  playPressed: {
    opacity: 0.7,
  },
  playLabel: {
    color: BRAND.accentText,
    fontSize: 14,
    fontWeight: "700",
  },
  sectionHeader: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  listContent: {
    paddingBottom: 96,
  },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 4,
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
});
