// オフラインダウンロードのトグルボタン（FINAL）。
// 3 モード:
//  - track:     1 曲。ダウンロード済みなら✓（タップで削除）/ 進行中はスピナー / 未取得はDLアイコン。
//  - tracks[]:  複数曲。タップで未取得分を順次DL。進行中は件数（done/total）を表示。
//  - albumName: album 名で引いて一括DL。進行中はスピナー。
// いずれも 1 つの props で受け、track > tracks > albumName の優先で振る舞う。

import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { type Track, useDownloads } from "@crateforge/core";
import { PALETTE } from "@/constants/brand";

export interface DownloadButtonProps {
  /** 単曲モード。 */
  track?: Track;
  /** 複数曲モード。 */
  tracks?: Track[];
  /** album 一括モード。 */
  albumName?: string;
  size?: number;
  /** アイコン右に出す任意ラベル。 */
  label?: string;
}

export default function DownloadButton({
  track,
  tracks,
  albumName,
  size = 22,
  label,
}: DownloadButtonProps) {
  const entries = useDownloads((s) => s.entries);
  const downloading = useDownloads((s) => s.downloading);
  const downloadTrack = useDownloads((s) => s.downloadTrack);
  const removeDownload = useDownloads((s) => s.removeDownload);
  const downloadMany = useDownloads((s) => s.downloadMany);
  const downloadAlbum = useDownloads((s) => s.downloadAlbum);

  // バッチ（tracks[]/album）の進行状態はローカルに持つ。
  const [batchBusy, setBatchBusy] = useState(false);

  // ---- 単曲モード ----
  if (track) {
    const id = track.trackId;
    const isDone = entries[id] != null;
    const isBusy = downloading[id] === true;

    const onPress = () => {
      if (isBusy) return;
      if (isDone) void removeDownload(id);
      else void downloadTrack(track);
    };

    return (
      <Shell onPress={onPress} disabled={isBusy} accessibilityLabel="ダウンロード">
        {isBusy ? (
          <ActivityIndicator size="small" color={PALETTE.accent} />
        ) : (
          <Ionicons
            name={isDone ? "checkmark-circle" : "download-outline"}
            size={size}
            color={isDone ? PALETTE.accent : PALETTE.textDim}
          />
        )}
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </Shell>
    );
  }

  // ---- バッチモード（tracks[] / albumName）----
  const list = tracks ?? [];
  const total = list.length;
  const doneCount = useMemo(
    () => list.reduce((n, t) => n + (entries[t.trackId] != null ? 1 : 0), 0),
    [list, entries],
  );
  const allDone = total > 0 && doneCount === total;

  const onPress = async () => {
    if (batchBusy) return;
    setBatchBusy(true);
    try {
      if (tracks && tracks.length) await downloadMany(tracks);
      else if (albumName) await downloadAlbum(albumName);
    } finally {
      setBatchBusy(false);
    }
  };

  const progressLabel = batchBusy
    ? total > 0
      ? `${doneCount}/${total}`
      : "..."
    : label ?? (albumName ? "アルバムを保存" : total > 0 ? `${total}曲を保存` : "保存");

  return (
    <Shell onPress={() => void onPress()} disabled={batchBusy} accessibilityLabel="一括ダウンロード">
      {batchBusy ? (
        <ActivityIndicator size="small" color={PALETTE.accent} />
      ) : (
        <Ionicons
          name={allDone ? "checkmark-circle" : "download-outline"}
          size={size}
          color={allDone ? PALETTE.accent : PALETTE.accent}
        />
      )}
      <Text style={styles.label}>{progressLabel}</Text>
    </Shell>
  );
}

/** 共通の押下シェル（ダーク + アクセント）。 */
function Shell({
  children,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={({ pressed }) => [styles.shell, pressed && !disabled && styles.pressed]}
    >
      <View style={styles.inner}>{children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shell: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pressed: {
    opacity: 0.6,
  },
  label: {
    color: PALETTE.accent,
    fontSize: 13,
    fontWeight: "600",
  },
});
