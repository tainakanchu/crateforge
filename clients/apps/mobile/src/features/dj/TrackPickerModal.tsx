// デッキへロードする曲を選ぶモーダル。検索 + 一覧（オンラインはサーバー検索、
// オフラインはダウンロード済みから絞り込み）。行タップで即ロードして閉じる。

import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Text, TextInput, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Track, trackTitle, trackArtist, useConnection, useDownloads, useSettings } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";
import IconButton from "@/components/IconButton";
import TrackRow from "@/components/TrackRow";
import { Loading, EmptyView } from "@/components/StateViews";
import { useTracks, BROWSE_LIMIT } from "@/features/browse/hooks";

import type { DeckId } from "./math";

export interface TrackPickerModalProps {
  /** 選択対象デッキ。null で非表示。 */
  deck: DeckId | null;
  onClose: () => void;
  onPick: (deck: DeckId, track: Track) => void;
}

export default function TrackPickerModal({ deck, onClose, onPick }: TrackPickerModalProps) {
  const insets = useSafeAreaInsets();
  const client = useConnection((s) => s.client);
  const entries = useDownloads((s) => s.entries);
  const trackSort = useSettings((s) => s.trackSort);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // モーダルを開き直すたびに検索をリセット。
  useEffect(() => {
    if (deck != null) {
      setSearch("");
      setDebounced("");
    }
  }, [deck]);

  // ライブラリ画面（曲モード）と同じクエリ形にしてキャッシュを共有する。
  const searchQuery = debounced.length >= 2 ? debounced : undefined;
  const tracksQuery = useTracks(
    { q: searchQuery, limit: BROWSE_LIMIT, sort: trackSort.field, order: trackSort.order },
    deck != null && !!client,
  );

  // オフライン: DL 済みから title/artist 部分一致で絞る。
  const offlineTracks = useMemo(() => {
    if (client) return [];
    const q = debounced.toLowerCase();
    return Object.values(entries)
      .map((e) => e.track)
      .filter(
        (t) =>
          q === "" ||
          trackTitle(t).toLowerCase().includes(q) ||
          trackArtist(t).toLowerCase().includes(q),
      )
      .sort((a, b) => trackTitle(a).localeCompare(trackTitle(b), undefined, { sensitivity: "base" }));
  }, [client, entries, debounced]);

  const tracks = client ? (tracksQuery.data ?? []) : offlineTracks;
  const loading = !!client && tracksQuery.isLoading;

  return (
    <Modal visible={deck != null} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            デッキ {deck === "b" ? "B" : "A"} にロード
          </Text>
          <IconButton name="close" onPress={onClose} accessibilityLabel="閉じる" />
        </View>

        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color={PALETTE.textFaint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="曲・アーティストを検索"
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

        {loading ? (
          <Loading />
        ) : tracks.length === 0 ? (
          <EmptyView
            message={client ? "曲が見つかりません" : "ダウンロード済みの曲がありません"}
          />
        ) : (
          <FlatList
            data={tracks}
            keyExtractor={(t) => String(t.trackId)}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <TrackRow
                track={item}
                onPress={() => {
                  if (deck != null) onPick(deck, item);
                }}
                trailing={
                  <Text style={styles.bpm}>
                    {item.bpm != null && item.bpm > 0 ? `${item.bpm}` : "--"}
                  </Text>
                }
              />
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerTitle: {
    color: PALETTE.text,
    fontSize: 16,
    fontWeight: "700",
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
  },
  searchInput: {
    flex: 1,
    color: PALETTE.text,
    fontSize: 14,
    paddingVertical: 10,
  },
  bpm: {
    color: PALETTE.textDim,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    minWidth: 32,
    textAlign: "right",
  },
});
