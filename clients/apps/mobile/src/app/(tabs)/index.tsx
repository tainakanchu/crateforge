// Library 画面。「アルバム」/「アーティスト」/「曲」トグルで表示を切替える。
// 曲モード: 検索 + ジャンルチップで絞り込み、タップで再生。長押しで追加アクション。
//           ソートコントロールで並び順を変更できる。
// アルバムモード: distinct アルバムを一覧。検索でクライアント絞り込み。タップで詳細へ。
// アーティストモード: クライアント側集計のアーティスト一覧。タップで詳細へ。

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";

import { type Album, type Artist, type DownloadedPlaylist, type SortField, type Track, useConnection, usePlayer, useDownloads, useSettings } from "@crateforge/core";
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

  // 既定は「アーティスト」モード（アーティスト→アルバム→曲の導線を優先）。
  const [mode, setMode] = useState<Mode>("artists");

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

  // 検索クエリは最小2文字ガード（debounced は trim 済み）。1文字だと巨大ヒット＝
  // 全件転送になり得るので投げない。空のときは undefined（フィルタ無し一覧）に戻る。
  const searchQuery = debounced.length >= 2 ? debounced : undefined;

  // アクティブなモードだけ取得する（既定アルバム時に全曲フェッチしない＝重さ回避）。
  const tracksQuery = useTracks(
    {
      q: searchQuery,
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
    return <OfflineLibrary />;
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
              onPress={() => {
                if (!item.album) return;
                router.push(`/album/${encodeURIComponent(item.album)}`);
              }}
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
        <>
          {/* データがありかつ裏で再取得中のとき、控えめな更新インジケータを出す */}
          {artistsQuery.data != null && artistsQuery.data.length > 0 && artistsQuery.isFetching ? (
            <View style={styles.fetchingBadge}>
              <Text style={styles.fetchingText}>更新中…</Text>
            </View>
          ) : null}
          <FlatList
            data={artists}
            keyExtractor={(a) => a.artist}
            renderItem={({ item }: { item: Artist }) => (
              <ArtistRow
                artist={item}
                onPress={() => {
                  if (!item.artist) return;
                  router.push(`/artist/${encodeURIComponent(item.artist)}`);
                }}
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
        </>
      )}
    </Screen>
  );
}

/**
 * オフライン（未接続）時の Library 表示。
 * 上部に「コレクション」セクション（DL済みアルバム・プレイリスト）を表示し、
 * その下に全ダウンロード済み曲の一覧を出す。何もなければ接続導線。
 */
function OfflineLibrary() {
  const router = useRouter();
  const entries = useDownloads((s) => s.entries);
  const playlists = useDownloads((s) => s.playlists);
  const getLocalArtworkUri = useDownloads((s) => s.getLocalArtworkUri);
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);
  // アーティストの束ね方は設定に追従する（artist ページの絞り込みと一致させ、
  // 遷移先が空になるのを防ぐ）。
  const artistGrouping = useSettings((s) => s.artistGrouping);

  // 新しい順（永続データは Record なので毎回整列）。
  const tracks = useMemo(
    () =>
      Object.values(entries)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((e) => e.track),
    [entries],
  );

  // entries から album 名でグルーピングしてアルバム一覧を導出する（album が空の曲は除外）。
  // アルバムごとに 曲数 / 表示アーティスト / アート用の代表トラックID を持たせる。
  const offlineAlbums = useMemo((): OfflineAlbum[] => {
    // album 名 → { 曲数, アーティスト集合, 代表トラックID } を集約。
    const map = new Map<
      string,
      { count: number; artists: Set<string>; repTrackId: number }
    >();
    for (const e of Object.values(entries)) {
      const album = e.track.album;
      if (!album) continue;
      const existing = map.get(album);
      if (existing) {
        existing.count += 1;
      } else {
        // そのアルバムで最初に見つかったDL曲を代表トラックにする。
        map.set(album, {
          count: 1,
          artists: new Set(),
          repTrackId: e.track.trackId,
        });
      }
      // 表示アーティストは albumArtist 優先・非空のみを distinct 収集。
      const artist = e.track.albumArtist ?? e.track.artist;
      if (artist) map.get(album)!.artists.add(artist);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({
        name,
        count: v.count,
        // distinct なアーティストが1つなら其れ、2つ以上なら "Various Artists"、空なら空文字。
        artist:
          v.artists.size === 0
            ? ""
            : v.artists.size === 1
              ? [...v.artists][0]
              : "Various Artists",
        repTrackId: v.repTrackId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entries]);

  // entries をアーティストでグルーピング（空アーティストは除外）。
  // 束ね方は設定 (artistGrouping) に追従させ、artist ページの nameOf と一致させる
  // （"albumArtist" なら albumArtist 優先、それ以外は artist 優先）。
  const offlineArtists = useMemo((): OfflineArtist[] => {
    const map = new Map<string, { count: number; repTrackId: number }>();
    for (const e of Object.values(entries)) {
      const name =
        artistGrouping === "albumArtist"
          ? (e.track.albumArtist ?? e.track.artist)
          : (e.track.artist ?? e.track.albumArtist);
      if (!name) continue;
      const existing = map.get(name);
      if (existing) {
        existing.count += 1;
      } else {
        // 最初に見つかったDL曲を代表トラックにする。
        map.set(name, { count: 1, repTrackId: e.track.trackId });
      }
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, count: v.count, repTrackId: v.repTrackId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entries, artistGrouping]);

  // DL済みプレイリスト（新しい順）。
  const offlinePlaylists = useMemo(
    () => Object.values(playlists).sort((a, b) => b.createdAt - a.createdAt),
    [playlists],
  );

  const hasCollection =
    offlineAlbums.length > 0 || offlineArtists.length > 0 || offlinePlaylists.length > 0;
  const hasAnything = tracks.length > 0 || hasCollection;

  const playFrom = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  return (
    <Screen>
      <View style={styles.offlineBanner}>
        <Ionicons name="cloud-offline-outline" size={15} color={PALETTE.textDim} />
        <Text style={styles.offlineText}>
          {tracks.length > 0
            ? `サーバー未接続 ・ ダウンロード済み ${tracks.length}曲`
            : "サーバー未接続"}
        </Text>
      </View>

      {!hasAnything ? (
        <>
          <EmptyView message="ダウンロード済みの曲はありません" icon="cloud-offline-outline" />
          <View style={styles.offlineActions}>
            <Pressable
              onPress={() => router.push("/connect")}
              accessibilityRole="button"
              accessibilityLabel="サーバーに接続"
              style={({ pressed }) => [styles.connectBtn, pressed && styles.pressed]}
            >
              <Ionicons name="wifi" size={18} color={BRAND.accentText} />
              <Text style={styles.connectBtnText}>サーバーに接続</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(t) => String(t.trackId)}
          renderItem={({ item, index }) => (
            <TrackRow
              track={item}
              active={currentTrackId === item.trackId}
              onPress={() => playFrom(index)}
            />
          )}
          ListHeaderComponent={
            hasCollection ? (
              <OfflineCollectionHeader
                albums={offlineAlbums}
                artists={offlineArtists}
                playlists={offlinePlaylists}
                getLocalArtworkUri={getLocalArtworkUri}
              />
            ) : (
              <Text style={styles.sectionHeader}>すべてのダウンロード</Text>
            )
          }
          contentContainerStyle={styles.listContent}
        />
      )}
    </Screen>
  );
}

/** オフライン時のアルバム集約（アート用代表トラック・表示アーティスト付き）。 */
type OfflineAlbum = { name: string; count: number; artist: string; repTrackId: number };
/** オフライン時のアーティスト集約（アート用代表トラック付き）。 */
type OfflineArtist = { name: string; count: number; repTrackId: number };

/**
 * ローカル保存アートの小サムネイル。アートが無ければ指定アイコンにフォールバック。
 * uri は getLocalArtworkUri(repTrackId) で得た file:// URI。
 */
function LocalArt({
  uri,
  fallbackIcon,
  circular,
}: {
  uri: string | null;
  fallbackIcon: keyof typeof Ionicons.glyphMap;
  circular?: boolean;
}) {
  const radius = circular ? COLLECTION_THUMB / 2 : COLLECTION_RADIUS;
  const dims = { width: COLLECTION_THUMB, height: COLLECTION_THUMB, borderRadius: radius };
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.collectionArt, dims]}
        contentFit="cover"
        transition={120}
        recyclingKey={uri}
      />
    );
  }
  return (
    <View style={[styles.collectionArtPlaceholder, dims]}>
      <Ionicons name={fallbackIcon} size={Math.round(COLLECTION_THUMB * 0.5)} color={PALETTE.textFaint} />
    </View>
  );
}

/**
 * オフライン時のコレクションセクション（アルバム・アーティスト・プレイリスト）。
 * OfflineLibrary の FlatList の ListHeaderComponent として使う。
 */
function OfflineCollectionHeader({
  albums,
  artists,
  playlists,
  getLocalArtworkUri,
}: {
  albums: OfflineAlbum[];
  artists: OfflineArtist[];
  playlists: DownloadedPlaylist[];
  getLocalArtworkUri: (trackId: number) => string | null;
}) {
  const router = useRouter();
  return (
    <View>
      <Text style={styles.sectionHeader}>コレクション</Text>

      {/* DL済みアルバム（アート＋アルバム名＋アーティスト＋曲数） */}
      {albums.length > 0 ? (
        <>
          <Text style={styles.collectionSubHeader}>アルバム</Text>
          {albums.map((a) => (
            <Pressable
              key={a.name}
              onPress={() => router.push(`/album/${encodeURIComponent(a.name)}`)}
              accessibilityRole="button"
              accessibilityLabel={a.name}
              style={({ pressed }) => [styles.collectionRow, pressed && styles.pressed]}
            >
              <LocalArt uri={getLocalArtworkUri(a.repTrackId)} fallbackIcon="albums-outline" />
              <View style={styles.collectionText}>
                <Text style={styles.collectionName} numberOfLines={1}>
                  {a.name}
                </Text>
                {a.artist ? (
                  <Text style={styles.collectionSub} numberOfLines={1}>
                    {a.artist}
                  </Text>
                ) : null}
                <Text style={styles.collectionMeta}>{a.count}曲</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={PALETTE.textFaint} />
            </Pressable>
          ))}
        </>
      ) : null}

      {/* DL済みアーティスト（円形アート＋アーティスト名＋曲数） */}
      {artists.length > 0 ? (
        <>
          <Text style={styles.collectionSubHeader}>アーティスト</Text>
          {artists.map((ar) => (
            <Pressable
              key={ar.name}
              onPress={() => router.push(`/artist/${encodeURIComponent(ar.name)}`)}
              accessibilityRole="button"
              accessibilityLabel={ar.name}
              style={({ pressed }) => [styles.collectionRow, pressed && styles.pressed]}
            >
              <LocalArt uri={getLocalArtworkUri(ar.repTrackId)} fallbackIcon="person-outline" circular />
              <View style={styles.collectionText}>
                <Text style={styles.collectionName} numberOfLines={1}>
                  {ar.name}
                </Text>
                <Text style={styles.collectionMeta}>{ar.count}曲</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={PALETTE.textFaint} />
            </Pressable>
          ))}
        </>
      ) : null}

      {/* DL済みプレイリスト */}
      {playlists.length > 0 ? (
        <>
          <Text style={styles.collectionSubHeader}>プレイリスト</Text>
          {playlists.map((p) => (
            <Pressable
              key={p.playlistId}
              onPress={() => router.push(`/playlist/${p.playlistId}`)}
              accessibilityRole="button"
              accessibilityLabel={p.name}
              style={({ pressed }) => [styles.collectionRow, pressed && styles.pressed]}
            >
              <Ionicons
                name="list"
                size={20}
                color={PALETTE.textDim}
                style={styles.collectionIcon}
              />
              <View style={styles.collectionText}>
                <Text style={styles.collectionName} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={styles.collectionMeta}>{p.trackIds.length}曲</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={PALETTE.textFaint} />
            </Pressable>
          ))}
        </>
      ) : null}

      {/* 全曲セクションの見出し */}
      <Text style={styles.sectionHeader}>すべてのダウンロード</Text>
    </View>
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

// コレクション行のサムネイル寸法（AlbumRow に倣う）。
const COLLECTION_THUMB = 44;
const COLLECTION_RADIUS = 6;

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
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  offlineText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  offlineActions: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  connectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.accent,
  },
  connectBtnText: {
    color: BRAND.accentText,
    fontSize: 15,
    fontWeight: "700",
  },
  sectionHeader: {
    color: PALETTE.textDim,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
  },
  collectionSubHeader: {
    color: PALETTE.textFaint,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 2,
  },
  collectionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PALETTE.border,
  },
  collectionIcon: {
    marginRight: 12,
  },
  collectionArt: {
    marginRight: 12,
    backgroundColor: PALETTE.surfaceAlt,
  },
  collectionArtPlaceholder: {
    marginRight: 12,
    backgroundColor: PALETTE.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  collectionText: {
    flex: 1,
    minWidth: 0,
  },
  collectionName: {
    color: PALETTE.text,
    fontSize: 15,
    fontWeight: "600",
  },
  collectionSub: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginTop: 1,
  },
  collectionMeta: {
    color: PALETTE.textFaint,
    fontSize: 13,
    marginTop: 1,
  },
  fetchingBadge: {
    alignSelf: "flex-end",
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 2,
  },
  fetchingText: {
    color: PALETTE.textFaint,
    fontSize: 11,
    fontStyle: "italic",
  },
});
