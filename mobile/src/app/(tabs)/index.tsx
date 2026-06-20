// Library 画面。上部の「曲」/「アルバム」トグルで表示を切替える。
// 曲モード: 検索 + ジャンルチップで曲を絞り込み、タップで「現在のリストを
//   キューにして」その位置から再生。各行に単曲ダウンロード、長押しで
//   「次に再生 / アルバムを保存」。
// アルバムモード: distinct アルバムを一覧。検索でアルバム名をクライアント絞り込み。
//   タップでアルバム詳細へ。
// プレイリストは専用タブへ移した。

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import type { Album, Track } from "@/lib/types";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import DownloadButton from "@/components/DownloadButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import { useConnection } from "@/store/connection";
import { usePlayer } from "@/store/player";
import { useDownloads } from "@/store/downloads";
import { useTracks, useGenres, useAlbums, BROWSE_LIMIT } from "@/features/browse/hooks";
import GenreChips from "@/features/browse/GenreChips";
import AlbumRow from "@/features/browse/AlbumRow";

type Mode = "tracks" | "albums";

export default function LibraryScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);

  const [mode, setMode] = useState<Mode>("tracks");

  // 検索はデバウンス（入力ごとに叩かない）。
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [genre, setGenre] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const tracksQuery = useTracks({
    q: debounced || undefined,
    genre: genre ?? undefined,
    limit: BROWSE_LIMIT,
  });
  const genresQuery = useGenres();
  const albumsQuery = useAlbums();

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
          placeholder={mode === "albums" ? "アルバムを検索" : "曲・アーティストを検索"}
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
      ) : (
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
      )}
    </Screen>
  );
}

/** 「曲」/「アルバム」のセグメント切替。 */
function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <View style={styles.toggle}>
      {(["tracks", "albums"] as const).map((m) => {
        const active = mode === m;
        const label = m === "tracks" ? "曲" : "アルバム";
        return (
          <Pressable
            key={m}
            onPress={() => onChange(m)}
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
  listContent: {
    paddingBottom: 96,
  },
  emptyContent: {
    flexGrow: 1,
  },
});
