// Crateforge TV ホーム画面（接続後に最初に表示される画面）。
//
// 構成（10ft UI / D-pad 操作前提）:
//   1. ウェルカム見出し（TV_FONT lg）＋ 接続先の控えめな表示。
//   2. クイックアクセス: 曲/アルバム/アーティスト/プレイリスト/検索 への横並びカード。
//      Focusable で D-pad フォーカス可能。決定で各ライブラリ画面へ router.push。
//   3. 「最近追加した曲」: core の ApiClient.listTracks（sort=dateAdded, order=desc）で
//      新着曲を取得し、共有の TrackRow を LibraryList（縦リスト）で表示する。行を選ぶと
//      usePlayer.setQueue でキューを新着曲に差し替え、その index から /player で再生する。
//
// データ取得は core の専用フックが無いため、songs.tsx と同じく client.listTracks を
// React Query で包む（mobile の useTracks と同型 / queryKey は ["tracks", query]）。
// クイックアクセスは常時表示し、新着曲セクションのローディング/空は LibraryList が吸収する
// （ナビ導線がローディング中に消えないよう、ヘッダはリスト外の固定領域に置く）。

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type Track, useConnection, usePlayer } from "@crateforge/core";
import { Focusable } from "@/components/focus";
import { TrackRow } from "@/components/library/TrackRow";
import { LibraryList } from "@/components/library/LibraryList";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

/** 新着曲の取得件数（ホームの「最近追加した曲」セクション用）。 */
const RECENT_LIMIT = 24;

/** クイックアクセスカードの定義（ライブラリ各画面への導線）。 */
const QUICK_ACCESS = [
  { label: "曲", icon: "musical-notes-outline", route: "/songs" },
  { label: "アルバム", icon: "albums-outline", route: "/albums" },
  { label: "アーティスト", icon: "person-outline", route: "/artists" },
  { label: "プレイリスト", icon: "list-outline", route: "/playlists" },
  { label: "検索", icon: "search-outline", route: "/search" },
] as const satisfies ReadonlyArray<{
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  route: string;
}>;

export default function HomeScreen() {
  const router = useRouter();
  const client = useConnection((s) => s.client);
  const baseUrl = useConnection((s) => s.baseUrl);
  // 再生中の曲をハイライトするための trackId。
  const currentTrackId = usePlayer((s) => s.current()?.trackId ?? null);

  // 最近追加した曲（dateAdded 降順）。client 未接続時は enabled:false で待機。
  const query = useQuery<Track[]>({
    queryKey: ["tracks", { limit: RECENT_LIMIT, sort: "dateAdded", order: "desc" }],
    enabled: !!client,
    queryFn: ({ signal }) =>
      client!.listTracks({ limit: RECENT_LIMIT, sort: "dateAdded", order: "desc" }, signal),
    placeholderData: keepPreviousData,
  });

  const recent = query.data ?? [];

  // 行選択: キューを新着曲で差し替え、その index から再生して Now Playing へ。
  const onSelectTrack = (index: number) => {
    usePlayer.getState().setQueue(recent, index);
    router.push("/player");
  };

  return (
    <View style={styles.container}>
      {/* ウェルカム見出し ＋ 接続先 */}
      <View style={styles.header}>
        <Text style={styles.welcome}>ようこそ、Crateforge へ</Text>
        {baseUrl ? <Text style={styles.connected}>接続先: {baseUrl}</Text> : null}
      </View>

      {/* クイックアクセスカード（横並び・D-pad フォーカス可能） */}
      <View style={styles.quickRow}>
        {QUICK_ACCESS.map((item, idx) => (
          <Focusable
            key={item.route}
            // 画面表示時は最初のカードにフォーカス（ここから下/右へ D-pad 移動）。
            hasTVPreferredFocus={idx === 0}
            onSelect={() =>
              router.push(item.route as Parameters<typeof router.push>[0])
            }
            style={styles.card}
            accessibilityLabel={item.label}
          >
            <Ionicons name={item.icon} size={44} color={PALETTE.teal} />
            <Text style={styles.cardLabel}>{item.label}</Text>
          </Focusable>
        ))}
      </View>

      {/* 最近追加した曲 */}
      <Text style={styles.sectionTitle}>最近追加した曲</Text>
      <LibraryList
        data={recent}
        keyExtractor={(t) => String(t.trackId)}
        isLoading={query.isLoading}
        isError={query.isError}
        errorMessage="曲の読み込みに失敗しました"
        emptyMessage="最近追加した曲はありません"
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            active={currentTrackId === item.trackId}
            onSelect={() => onSelectTrack(index)}
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
  header: {
    marginBottom: 24,
  },
  welcome: {
    fontSize: TV_FONT.lg,
    fontWeight: "700",
    color: PALETTE.teal,
  },
  connected: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 8,
    fontFamily: "monospace",
  },
  quickRow: {
    flexDirection: "row",
    gap: 20,
    marginBottom: 28,
  },
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 28,
    borderRadius: FOCUS_RING.borderRadius,
    backgroundColor: PALETTE.surface,
    // フォーカス時に default focusedStyle(FOCUS_RING) が border を足してもガタつかないよう、
    // 同じ太さの透明ボーダーを基底に持たせる（TrackRow と同方針）。
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  cardLabel: {
    fontSize: TV_FONT.sm,
    fontWeight: "600",
    color: PALETTE.text,
  },
  sectionTitle: {
    fontSize: TV_FONT.md,
    fontWeight: "700",
    color: PALETTE.text,
    marginBottom: 16,
  },
});
