// プレイリスト一覧画面（10ft UI / D-pad 操作前提）。
// core の ApiClient.playlists()（useConnection().client 経由）でフラットな全プレイリストを
// 取得し、persistentId / parentPersistentId からフォルダ階層を再構成して縦リスト表示する。
//
// 画面内ナビゲーション（新ルートを足さず 1 画面で完結）:
//   - ルート/フォルダの一覧 → フォルダ選択で下階層へ、プレイリスト選択で詳細（曲一覧）へ。
//   - 詳細 → 行選択でその位置から全曲を usePlayer.setQueue してキューを差し替え、/player へ。
//   - 「すべて再生」ボタンで先頭から一括再生も可能。
//
// データ取得は core の専用フックが無いため songs.tsx と同じく client メソッドを React Query で
// 包む（mobile の usePlaylists/usePlaylistTracks と同型・queryKey も統一）。共有の TrackRow /
// LibraryList を流用し、フォルダ/戻る/すべて再生のボタンは Focusable でフォーカス可能にする。

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type Playlist, type Track, useConnection, usePlayer } from "@crateforge/core";
import { Focusable } from "@/components/focus";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

/** 大規模ライブラリでも全件取得（mobile の BROWSE_LIMIT と同値）。 */
const BROWSE_LIMIT = 100000;

// ---- プレイリスト階層ヘルパ（mobile features/browse/playlistTree.ts と同等のロジックを移植）----
// API は全プレイリストをフラットに返すので、persistentId / parentPersistentId で木を再構成する。
// フォルダは曲を持たない（trackCount 0）が子を含むため、trackCount で落としてはいけない。

/** persistentId（無ければ playlistId 文字列）。親子の突き合わせキーとして使う。 */
function keyOf(p: Playlist): string {
  return p.persistentId ?? String(p.playlistId);
}

/** フォルダ優先 → 名前の昇順で並べる。 */
function sortItems(items: Playlist[]): Playlist[] {
  return [...items].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** parentPersistentId が parentPid に一致する子を、フォルダ優先・名前順で返す。 */
function childrenOf(all: Playlist[], parentPid: string | null): Playlist[] {
  return sortItems(all.filter((p) => (p.parentPersistentId ?? null) === parentPid));
}

/** ルート（最上位）に置く項目。親が無い/空、または親が一覧に存在しない（=孤児）ものを採用。 */
function rootItems(all: Playlist[]): Playlist[] {
  const present = new Set(all.map(keyOf));
  const roots = all.filter((p) => {
    const parent = p.parentPersistentId;
    if (parent == null || parent === "") return true;
    return !present.has(parent);
  });
  return sortItems(roots);
}

/** フォルダ階層のパンくず 1 段。 */
type FolderCrumb = { pid: string; name: string };

export default function PlaylistsScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // 画面内ナビゲーション状態。folderStack=現在のフォルダ階層、openPlaylist=詳細表示中のプレイリスト。
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([]);
  const [openPlaylist, setOpenPlaylist] = useState<Playlist | null>(null);

  // 全プレイリスト取得（mobile usePlaylists と同型）。client 未接続時は enabled:false で待機。
  const playlistsQuery = useQuery<Playlist[]>({
    queryKey: ["playlists"],
    enabled: !!client,
    queryFn: () => client!.playlists(),
  });
  const allPlaylists = playlistsQuery.data ?? [];

  // 現在フォルダの直下項目（root か フォルダ内）。空の通常プレイリストだけ間引く（フォルダは残す）。
  const currentFolderPid =
    folderStack.length > 0 ? folderStack[folderStack.length - 1].pid : null;
  const rows = useMemo(() => {
    const items =
      currentFolderPid == null
        ? rootItems(allPlaylists)
        : childrenOf(allPlaylists, currentFolderPid);
    return items.filter((p) => (p.isFolder ? true : p.trackCount > 0));
  }, [allPlaylists, currentFolderPid]);

  // 詳細表示中プレイリストの曲（mobile usePlaylistTracks と同型）。openPlaylist が無ければ無効。
  const tracksQuery = useQuery<Track[]>({
    queryKey: ["playlist-tracks", openPlaylist?.playlistId],
    enabled: !!client && openPlaylist != null,
    queryFn: () => client!.playlistTracks(openPlaylist!.playlistId, { limit: BROWSE_LIMIT }),
  });
  const tracks = tracksQuery.data ?? [];

  // 行選択（一覧）: フォルダは下階層へ、プレイリストは詳細（曲一覧）へ。
  const onSelectRow = (p: Playlist) => {
    if (p.isFolder) {
      setFolderStack((s) => [...s, { pid: keyOf(p), name: p.name }]);
    } else {
      setOpenPlaylist(p);
    }
  };

  // 詳細の行選択: その位置からプレイリスト全曲をキューにして再生し、Now Playing へ。
  const onPlayAt = (index: number) => {
    usePlayer.getState().setQueue(tracks, index);
    router.push("/player");
  };

  // 1 段戻る: 詳細を開いていれば一覧へ、フォルダ内なら親フォルダへ。
  const goBack = () => {
    if (openPlaylist) {
      setOpenPlaylist(null);
    } else {
      setFolderStack((s) => s.slice(0, -1));
    }
  };

  const canGoBack = openPlaylist != null || folderStack.length > 0;
  const titleText = openPlaylist
    ? openPlaylist.name
    : folderStack.length > 0
      ? folderStack[folderStack.length - 1].name
      : "プレイリスト";

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        {canGoBack ? (
          <Focusable onSelect={goBack} style={styles.iconBtn} accessibilityLabel="戻る">
            <Ionicons name="chevron-back" size={28} color={PALETTE.text} />
          </Focusable>
        ) : null}
        <Text style={styles.title} numberOfLines={1}>
          {titleText}
        </Text>
        {openPlaylist && tracks.length > 0 ? (
          <Focusable
            onSelect={() => onPlayAt(0)}
            style={styles.playAllBtn}
            accessibilityLabel="すべて再生"
          >
            <Ionicons name="play" size={22} color={PALETTE.bg} />
            <Text style={styles.playAllText}>すべて再生</Text>
          </Focusable>
        ) : null}
      </View>

      {openPlaylist ? (
        // 詳細: プレイリスト内の曲を縦リスト表示。
        <LibraryList
          data={tracks}
          keyExtractor={(t) => String(t.trackId)}
          isLoading={tracksQuery.isLoading}
          isError={tracksQuery.isError}
          errorMessage="曲の読み込みに失敗しました"
          emptyMessage="このプレイリストは空です"
          renderItem={({ item, index }) => (
            <TrackRow
              track={item}
              index={index + 1}
              active={currentTrackId === item.trackId}
              hasTVPreferredFocus={index === 0}
              onSelect={() => onPlayAt(index)}
            />
          )}
        />
      ) : (
        // 一覧: ルート/フォルダ直下のプレイリスト・フォルダを縦リスト表示。
        <LibraryList
          data={rows}
          keyExtractor={(p) => String(p.playlistId)}
          isLoading={playlistsQuery.isLoading}
          isError={playlistsQuery.isError}
          errorMessage="プレイリストの読み込みに失敗しました"
          emptyMessage="プレイリストがありません"
          renderItem={({ item, index }) => (
            <PlaylistRow
              playlist={item}
              hasTVPreferredFocus={index === 0}
              onSelect={() => onSelectRow(item)}
            />
          )}
        />
      )}
    </View>
  );
}

/** フォーカス可能なプレイリスト/フォルダ行。アイコン + 名前 + 種別/曲数を 1 行で表示する。 */
function PlaylistRow({
  playlist,
  onSelect,
  hasTVPreferredFocus,
}: {
  playlist: Playlist;
  onSelect: () => void;
  hasTVPreferredFocus?: boolean;
}) {
  const isFolder = playlist.isFolder;
  const meta = isFolder ? "フォルダ" : `${playlist.trackCount}曲`;
  return (
    <Focusable
      onSelect={onSelect}
      hasTVPreferredFocus={hasTVPreferredFocus}
      style={styles.row}
      accessibilityLabel={`${playlist.name}, ${meta}`}
    >
      <View style={styles.rowIcon}>
        <Ionicons
          name={isFolder ? "folder" : "musical-notes"}
          size={30}
          color={isFolder ? PALETTE.teal : PALETTE.textSub}
        />
      </View>
      <View style={styles.rowTexts}>
        <Text style={styles.rowName} numberOfLines={1}>
          {playlist.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={24} color={PALETTE.textSub} />
    </Focusable>
  );
}

const ICON = 56;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.bg,
    paddingHorizontal: TV_LAYOUT.contentPaddingH,
    paddingVertical: TV_LAYOUT.contentPaddingV,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: TV_FONT.lg,
    fontWeight: "700",
    color: PALETTE.teal,
  },
  iconBtn: {
    width: ICON,
    height: ICON,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: FOCUS_RING.borderRadius,
    backgroundColor: PALETTE.surface,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  playAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: FOCUS_RING.borderRadius,
    backgroundColor: PALETTE.teal,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  playAllText: {
    fontSize: TV_FONT.sm,
    fontWeight: "700",
    color: PALETTE.bg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginVertical: 2,
    // フォーカス時に default focusedStyle(FOCUS_RING) が borderColor を teal に
    // 差し替えても行がガタつかないよう、同じ太さの透明ボーダーを基底に持たせる。
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
    borderRadius: FOCUS_RING.borderRadius,
  },
  rowIcon: {
    width: ICON,
    height: ICON,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    flexShrink: 0,
  },
  rowTexts: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: TV_FONT.sm,
    fontWeight: "600",
    color: PALETTE.text,
  },
  rowMeta: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 4,
  },
});
