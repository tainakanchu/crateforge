// Library 画面。「アルバム」/「アーティスト」/「曲」トグルで表示を切替える。
// 曲モード: 検索 + ジャンルチップで絞り込み、タップで再生。長押しで追加アクション。
//           ソートコントロールで並び順を変更できる。
// アルバムモード: distinct アルバムを一覧。検索でクライアント絞り込み。タップで詳細へ。
// アーティストモード: クライアント側集計のアーティスト一覧。タップで詳細へ。

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { type Album, type Artist, type SortField, type Track, useConnection, usePlayer, useDownloads, useSettings } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import DownloadButton from "@/components/DownloadButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { useTracks, useGenres, useAlbums, useArtists, BROWSE_LIMIT } from "@/features/browse/hooks";
import GenreChips from "@/features/browse/GenreChips";
import AlbumRow from "@/features/browse/AlbumRow";
import ArtistRow from "@/features/browse/ArtistRow";

type Mode = "tracks" | "albums" | "artists";

/** ソートフィールドの日本語ラベル。 */
const SORT_FIELD_LABELS: Record<SortField, string> = {
  name: "名前",
  artist: "アーティスト",
  album: "アルバム",
  dateAdded: "追加日",
  year: "年",
  bpm: "BPM",
  rating: "レート",
  playCount: "再生回数",
};

const SORT_FIELDS: SortField[] = ["name", "artist", "album", "dateAdded", "year", "bpm", "rating", "playCount"];

export default function LibraryScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);

  const [mode, setMode] = useState<Mode>("albums");

  // 検索はデバウンス（入力ごとに叩かない）。
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [genre, setGenre] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // 曲ソート設定。
  const trackSort = useSettings((s) => s.trackSort);
  const setTrackSort = useSettings((s) => s.setTrackSort);

  // アクティブなモードだけ取得する（既定アルバム時に全曲フェッチしない＝重さ回避）。
  const tracksQuery = useTracks(
    {
      q: debounced || undefined,
      genre: genre ?? undefined,
      limit: BROWSE_LIMIT,
      sort: trackSort.field,
      order: trackSort.order,
    },
    mode === "tracks",
  );
  const genresQuery = useGenres();
  const albumsQuery = useAlbums(mode === "albums");
  const artistsQuery = useArtists(mode === "artists");

  const tracks = tracksQuery.data ?? [];
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);
  const listRef = useRef<FlatList<Track>>(null);

  // アルバムモードは検索でアルバム名をクライアント側で絞り込む。
  const albums = useMemo(() => {
    const all = albumsQuery.data ?? [];
    const q = debounced.toLowerCase();
    if (!q) return all;
    return all.filter((a) => a.album.toLowerCase().includes(q));
  }, [albumsQuery.data, debounced]);

  // アーティストモードは検索でアーティスト名をクライアント側で絞り込む。
  const artists = useMemo((): Artist[] => {
    const all: Artist[] = artistsQuery.data ?? [];
    const q = debounced.toLowerCase();
    if (!q) return all;
    return all.filter((a) => a.artist.toLowerCase().includes(q));
  }, [artistsQuery.data, debounced]);

  const onPressTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  // 長押しで曲ごとのアクションを選ぶ。
  const onLongPressTrack = (track: Track) => {
    const buttons: Parameters<typeof Alert.alert>[2] = [
      { text: "次に再生", onPress: () => usePlayer.getState().enqueueNext(track) },
    ];
    if (track.album) {
      buttons.push({
        text: "アルバムを保存",
        onPress: () => void useDownloads.getState().downloadAlbum(track.album!),
      });
    }
    buttons.push({ text: "キャンセル", style: "cancel" });
    Alert.alert(track.name || "この曲", undefined, buttons);
  };

  /** ソートフィールド選択ダイアログを開く。 */
  const openSortPicker = () => {
    const buttons: Parameters<typeof Alert.alert>[2] = SORT_FIELDS.map((field) => ({
      text:
        trackSort.field === field
          ? `✓ ${SORT_FIELD_LABELS[field]}`
          : SORT_FIELD_LABELS[field],
      onPress: () => setTrackSort({ field, order: trackSort.order }),
    }));
    buttons.push({ text: "キャンセル", style: "cancel" });
    Alert.alert("並び順", undefined, buttons);
  };

  /** asc/desc トグル。 */
  const toggleOrder = () => {
    setTrackSort({ field: trackSort.field, order: trackSort.order === "asc" ? "desc" : "asc" });
  };

  const searchPlaceholder =
    mode === "albums"
      ? "アルバムを検索"
      : mode === "artists"
        ? "アーティストを検索"
        : "曲・アーティストを検索";

  if (!client) {
    return (
      <Screen>
        <EmptyView message="サーバーに接続してください" icon="wifi-outline" />
      </Screen>
    );
  }

  return (
    <Screen>
      <ModeToggle mode={mode} onChange={setMode} />

      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={PALETTE.textFaint} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={searchPlaceholder}
          placeholderTextColor={PALETTE.textFaint}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="検索"
        />
        {search !== "" ? (
          <IconButton
            name="close-circle"
            onPress={() => setSearch("")}
            size={18}
            color={PALETTE.textFaint}
            accessibilityLabel="検索をクリア"
          />
        ) : null}
      </View>

      {mode === "tracks" ? (
        <>
          <GenreChips genres={genresQuery.data ?? []} selected={genre} onSelect={setGenre} />

          {/* 曲モードのソートコントロール */}
          <View style={styles.sortBar}>
            <Pressable
              onPress={openSortPicker}
              accessibilityRole="button"
              accessibilityLabel="ソートフィールドを選択"
              style={({ pressed }) => [styles.sortFieldBtn, pressed && styles.pressed]}
            >
              <Ionicons name="swap-vertical" size={15} color={PALETTE.textDim} />
              <Text style={styles.sortFieldText}>{SORT_FIELD_LABELS[trackSort.field]}</Text>
            </Pressable>
            <IconButton
              name={trackSort.order === "asc" ? "arrow-up" : "arrow-down"}
              onPress={toggleOrder}
              size={16}
              color={PALETTE.textDim}
              accessibilityLabel={trackSort.order === "asc" ? "昇順" : "降順"}
            />
          </View>

          <FlatList
            ref={listRef}
            data={tracks}
            keyExtractor={(t) => String(t.trackId)}
            renderItem={({ item, index }) => (
              <TrackRow
                track={item}
                active={currentTrackId === item.trackId}
                onPress={() => onPressTrack(index)}
                onLongPress={() => onLongPressTrack(item)}
                trailing={<DownloadButton track={item} />}
              />
            )}
            ListEmptyComponent={
              tracksQuery.isLoading ? (
                <Loading />
              ) : tracksQuery.isError ? (
                <ErrorView
                  message={errorText(tracksQuery.error)}
                  onRetry={() => tracksQuery.refetch()}
                />
              ) : (
                <EmptyView message="曲が見つかりません" icon="musical-notes-outline" />
              )
            }
            contentContainerStyle={tracks.length === 0 ? styles.emptyContent : styles.listContent}
            keyboardShouldPersistTaps="handled"
          />
        </>
      ) : mode === "albums" ? (
        <FlatList
          data={albums}
          keyExtractor={(a) => a.album}
          renderItem={({ item }: { item: Album }) => (
            <AlbumRow
              album={item}
              onPress={() => router.push(`/album/${encodeURIComponent(item.album)}`)}
            />
          )}
          ListEmptyComponent={
            albumsQuery.isLoading ? (
              <Loading />
            ) : albumsQuery.isError ? (
              <ErrorView
                message={errorText(albumsQuery.error)}
                onRetry={() => albumsQuery.refetch()}
              />
            ) : (
              <EmptyView message="アルバムが見つかりません" icon="albums-outline" />
            )
          }
          contentContainerStyle={albums.length === 0 ? styles.emptyContent : styles.listContent}
          keyboardShouldPersistTaps="handled"
        />
      ) : (
        <FlatList
          data={artists}
          keyExtractor={(a) => a.artist}
          renderItem={({ item }: { item: Artist }) => (
            <ArtistRow
              artist={item}
              onPress={() => router.push(`/artist/${encodeURIComponent(item.artist)}`)}
            />
          )}
          ListEmptyComponent={
            artistsQuery.isLoading ? (
              <Loading />
            ) : artistsQuery.isError ? (
              <ErrorView
                message={errorText(artistsQuery.error)}
                onRetry={() => artistsQuery.refetch()}
              />
            ) : (
              <EmptyView message="アーティストが見つかりません" icon="person-outline" />
            )
          }
          contentContainerStyle={artists.length === 0 ? styles.emptyContent : styles.listContent}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </Screen>
  );
}

/** 「アルバム」/「アーティスト」/「曲」のセグメント切替。 */
function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const OPTIONS: { value: Mode; label: string }[] = [
    { value: "albums", label: "アルバム" },
    { value: "artists", label: "アーティスト" },
    { value: "tracks", label: "曲" },
  ];
  return (
    <View style={styles.toggle}>
      {OPTIONS.map(({ value, label }) => {
        const active = mode === value;
        return (
          <Pressable
            key={value}
            onPress={() => onChange(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "読み込みに失敗しました";
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: "row",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 3,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    borderRadius: 7,
  },
  segmentActive: {
    backgroundColor: PALETTE.accent,
  },
  segmentText: {
    color: PALETTE.textDim,
    fontSize: 14,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: BRAND.accentText,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  searchInput: {
    flex: 1,
    color: PALETTE.text,
    fontSize: 15,
    padding: 0,
  },
  sortBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginHorizontal: 16,
    marginTop: 4,
  },
  sortFieldBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  sortFieldText: {
    color: PALETTE.textDim,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.7,
  },
  listContent: {
    paddingBottom: 96,
  },
  emptyContent: {
    flexGrow: 1,
  },
});
