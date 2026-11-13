// Library 画面。「アルバム」/「アーティスト」/「曲」トグルで表示を切替える。
// 曲モード: 検索 + ジャンルチップで絞り込み、タップで再生。長押しで追加アクション。
//           ソートコントロールで並び順を変更できる。
// アルバムモード: distinct アルバムを一覧。検索でクライアント絞り込み。タップで詳細へ。
// アーティストモード: クライアント側集計のアーティスト一覧。タップで詳細へ。

import { albumHref, artistHref } from "@/lib/albumHref";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, TextInput, View, StyleSheet } from "react-native";
import { isSearchable, matchesNormalized, naturalCompare } from "@/lib/normalize";
import { loadPref, savePref } from "@/lib/prefs";
import { showActionSheet } from "@/components/ActionSheet";
import { showTrackMenu } from "@/features/playback/trackMenu";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";

import { type Album, type Artist, type DownloadedPlaylist, type SortField, type Track, albumLabel, artistLabel, trackAlbumArtistKey, trackArtistKey, useConnection, usePlayer, useDownloads, useSettings, describeApiError } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import TrackRow from "@/components/TrackRow";
import IconButton from "@/components/IconButton";
import DownloadButton from "@/components/DownloadButton";
import { Loading, ErrorView, EmptyView } from "@/components/StateViews";
import ConnectionNotice from "@/components/ConnectionNotice";
import { useTracks, useGenres, useAlbums, useArtists, BROWSE_LIMIT } from "@/features/browse/hooks";
import GenreChips from "@/features/browse/GenreChips";
import AlbumRow from "@/features/browse/AlbumRow";
import ArtistRow from "@/features/browse/ArtistRow";
import { LIGHT_LIST_FRESH_MS, usePullToRefresh, useRefetchStaleOnFocus } from "@/hooks/use-refresh";

type Mode = "tracks" | "albums" | "artists";

/** ソートフィールドの日本語ラベル。 */
const SORT_FIELD_LABELS: Record<SortField, string> = {
  name: "名前",
  artist: "アーティスト",
  album: "アルバム",
  dateAdded: "追加日",
  year: "年",
  bpm: "BPM",
  rating: "評価",
  playCount: "再生回数",
};

const MODE_PREF_KEY = "crateforge.ui.libraryMode";

const SORT_FIELDS: SortField[] = ["name", "artist", "album", "dateAdded", "year", "bpm", "rating", "playCount"];

export default function LibraryScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);

  // 既定は「アーティスト」モード（アーティスト→アルバム→曲の導線を優先）。
  const [mode, setModeState] = useState<Mode>("artists");
  const modeTouched = useRef(false);
  const setMode = (m: Mode) => {
    modeTouched.current = true;
    setModeState(m);
    void savePref(MODE_PREF_KEY, m);
  };
  // 前回の表示モードを復元する（復元前にユーザーが切り替えていたらそちらを優先）。
  useEffect(() => {
    void loadPref(MODE_PREF_KEY).then((v) => {
      if (modeTouched.current) return;
      if (v === "tracks" || v === "albums" || v === "artists") setModeState(v);
    });
  }, []);

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
  // 全件転送になり得るので投げない。ただし CJK は 1 文字でも意味を持つので 1 文字から検索する。
  // 空のときは undefined（フィルタ無し一覧）に戻る。
  const searchQuery = isSearchable(debounced) ? debounced : undefined;

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

  // プル更新（表示中モードの一覧 + ジャンル）と、タブに戻ったときの再取得（stale のみ）。
  const refetchActive = useCallback(
    () =>
      Promise.all([
        mode === "tracks"
          ? tracksQuery.refetch()
          : mode === "albums"
            ? albumsQuery.refetch()
            : artistsQuery.refetch(),
        genresQuery.refetch(),
      ]),
    [mode, tracksQuery, albumsQuery, artistsQuery, genresQuery],
  );
  const { refreshing, onRefresh } = usePullToRefresh(refetchActive);
  // タブに戻ったら表示中モードの一覧だけ取り直す（他タブのクエリは対象外。ジャンルは曲モードのみ表示。round-3 N5）。
  // アルバム/アーティストは軽いので 10 秒の鮮度閾値、全曲一覧は従来どおり stale（5 分）のときだけ。
  useRefetchStaleOnFocus(
    mode === "tracks"
      ? [{ queryKey: ["tracks"] }, { queryKey: ["genres"] }]
      : mode === "albums"
        ? [{ queryKey: ["albums"], freshMs: LIGHT_LIST_FRESH_MS }]
        : [{ queryKey: ["artists"], freshMs: LIGHT_LIST_FRESH_MS }],
  );
  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={PALETTE.accent}
      colors={[PALETTE.accent]}
    />
  );

  const tracks = tracksQuery.data ?? [];
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);
  const listRef = useRef<FlatList<Track>>(null);

  // アルバムモードは検索でアルバム名をクライアント側で絞り込む。
  // 全角半角・かなカナ・大小・記号のゆれは正規化して吸収し、並びは自然順（2 < 10）。
  // 不明なアルバム（album: ""）は末尾に置き、検索は表示ラベル（「不明なアルバム」）で照合する。
  const albums = useMemo(() => {
    const all = [...(albumsQuery.data ?? [])].sort(compareNamesUnknownLast((a) => a.album));
    if (!debounced) return all;
    return all.filter((a) => matchesNormalized(albumLabel(a.album), debounced));
  }, [albumsQuery.data, debounced]);

  // アーティストモードは検索でアーティスト名をクライアント側で絞り込む。
  // 不明なアーティスト（artist: ""）は末尾、検索は表示ラベルで照合する。
  const artists = useMemo((): Artist[] => {
    const all: Artist[] = [...(artistsQuery.data ?? [])].sort(
      compareNamesUnknownLast((a) => a.artist),
    );
    if (!debounced) return all;
    return all.filter((a) => matchesNormalized(artistLabel(a.artist), debounced));
  }, [artistsQuery.data, debounced]);

  const onPressTrack = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  /** ソートフィールド選択ダイアログを開く。 */
  const openSortPicker = () => {
    showActionSheet({
      title: "並び順",
      actions: SORT_FIELDS.map((field) => ({
        label: SORT_FIELD_LABELS[field],
        selected: trackSort.field === field,
        onPress: () => setTrackSort({ field, order: trackSort.order }),
      })),
    });
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
              accessibilityLabel="並び順を選択"
              hitSlop={{ top: 4, bottom: 4 }}
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
                onLongPress={() => showTrackMenu(item)}
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
            refreshControl={refreshControl}
          />
        </>
      ) : mode === "albums" ? (
        <FlatList
          data={albums}
          keyExtractor={(a) => a.album}
          renderItem={({ item }: { item: Album }) => (
            <AlbumRow
              album={item}
              // 不明なアルバム（空名）も albumHref が unknown=1 のルートへ振り分ける。
              onPress={() => router.push(albumHref(item.album))}
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
          refreshControl={refreshControl}
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
                // 不明なアーティスト（空名）も artistHref が unknown=1 のルートへ振り分ける。
                onPress={() => router.push(artistHref(item.artist))}
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
            refreshControl={refreshControl}
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

  // entries から album 名でグルーピングしてアルバム一覧を導出する（album が空の曲は "" の
  // 「不明なアルバム」1 件にまとめて末尾）。
  // アルバムごとに 曲数 / 表示アーティスト / アート用の代表トラックID を持たせる。
  const offlineAlbums = useMemo((): OfflineAlbum[] => {
    // album 名 → { 曲数, アーティスト集合, 代表トラックID } を集約。
    const map = new Map<
      string,
      { count: number; artists: Set<string>; repTrackId: number }
    >();
    for (const e of Object.values(entries)) {
      const album = e.track.album?.trim() ? e.track.album : "";
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
      // 表示アーティストは albumArtist 優先で distinct 収集。通常のアルバムは非空のみ数える。
      // 不明なアルバムは寄せ集めなので、アーティスト無しの曲も 1 値として数える
      // （サーバーの /api/albums と同じ規則。数えないと特定アーティストのアルバムに見える）。
      const artist = (e.track.albumArtist?.trim() || e.track.artist?.trim() || "");
      if (artist || album === "") map.get(album)!.artists.add(artist);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({
        name,
        count: v.count,
        // distinct なアーティストが1つなら其れ、2つ以上なら "Various Artists"、空なら空文字。
        // 不明なアルバムで複数アーティストなら、Various Artists ではなく空文字（サーバーの NULL に対応）。
        artist:
          v.artists.size === 0
            ? ""
            : v.artists.size === 1
              ? [...v.artists][0]
              : name === ""
                ? ""
                : "Various Artists",
        repTrackId: v.repTrackId,
      }))
      .sort(compareNamesUnknownLast((a) => a.name));
  }, [entries]);

  // entries をアーティストでグルーピング（空アーティストは "" の「不明なアーティスト」1 件で末尾）。
  // 束ね方は設定 (artistGrouping) に追従させ、artist ページの nameOf と一致させる
  // （"albumArtist" なら albumArtist 優先、それ以外は artist 優先）。
  const offlineArtists = useMemo((): OfflineArtist[] => {
    const map = new Map<string, { count: number; repTrackId: number }>();
    for (const e of Object.values(entries)) {
      // 束ねキーはアーティスト画面のオフライン絞り込み（trackArtistKey 等）と同じ。
      const name =
        artistGrouping === "albumArtist" ? trackAlbumArtistKey(e.track) : trackArtistKey(e.track);
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
      .sort(compareNamesUnknownLast((a) => a.name));
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
      {/* 未接続の理由 1 行 + 復帰導線（トークン再入力 / 再試行 / 接続画面へ）。 */}
      <ConnectionNotice suffix={tracks.length > 0 ? `ダウンロード済み ${tracks.length}曲` : null} />

      {!hasAnything ? (
        <EmptyView message="ダウンロード済みの曲はありません" icon="cloud-offline-outline" />
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

/**
 * 名前の自然順比較。ただし空名（不明なアルバム / アーティスト）は常に末尾に置く
 * （デスクトップの Artists / Albums と同じ並び）。
 */
function compareNamesUnknownLast<T>(nameOf: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const an = nameOf(a).trim();
    const bn = nameOf(b).trim();
    if (!an !== !bn) return an ? -1 : 1;
    return naturalCompare(nameOf(a), nameOf(b));
  };
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
              onPress={() => router.push(albumHref(a.name))}
              accessibilityRole="button"
              accessibilityLabel={albumLabel(a.name)}
              style={({ pressed }) => [styles.collectionRow, pressed && styles.pressed]}
            >
              <LocalArt uri={getLocalArtworkUri(a.repTrackId)} fallbackIcon="albums-outline" />
              <View style={styles.collectionText}>
                <Text style={styles.collectionName} numberOfLines={1}>
                  {albumLabel(a.name)}
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
              onPress={() => router.push(artistHref(ar.name))}
              accessibilityRole="button"
              accessibilityLabel={artistLabel(ar.name)}
              style={({ pressed }) => [styles.collectionRow, pressed && styles.pressed]}
            >
              <LocalArt uri={getLocalArtworkUri(ar.repTrackId)} fallbackIcon="person-outline" circular />
              <View style={styles.collectionText}>
                <Text style={styles.collectionName} numberOfLines={1}>
                  {artistLabel(ar.name)}
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
  return describeApiError(e, { action: "読み込み" });
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
    minHeight: 36,
    paddingVertical: 4,
    paddingHorizontal: 10,
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
