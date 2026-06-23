// Settings 画面。現在の接続情報（baseUrl / token マスク）と状態を表示し、
// 再接続・切断を行う。接続中ならサーバー/ライブラリ情報も表示する。

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import Screen from "@/components/Screen";
import { type ArtistGrouping, type TrackMetaField, formatDuration, useConnection, useDownloads, useSettings } from "@crateforge/core";
import QualityPicker from "@/features/offline/QualityPicker";
import { formatBytes } from "@/features/offline/format";
import { BRAND, PALETTE } from "@/constants/brand";

/** トークンを先頭/末尾だけ残してマスクする。 */
function maskToken(token: string | null): string {
  if (!token) return "（なし）";
  if (token.length <= 4) return "••••";
  return `${token.slice(0, 2)}••••${token.slice(-2)}`;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "未接続",
  connecting: "接続中…",
  connected: "接続済み",
  error: "エラー",
};

const META_FIELD_OPTIONS: { field: TrackMetaField; label: string }[] = [
  { field: "bpm", label: "BPM" },
  { field: "year", label: "年" },
  { field: "genre", label: "ジャンル" },
  { field: "rating", label: "レート" },
  { field: "playCount", label: "再生回数" },
];

export default function SettingsScreen() {
  const router = useRouter();
  const baseUrl = useConnection((s) => s.baseUrl);
  const token = useConnection((s) => s.token);
  const status = useConnection((s) => s.status);
  const error = useConnection((s) => s.error);
  const client = useConnection((s) => s.client);

  const connected = status === "connected";
  const connecting = status === "connecting";

  // オフライン関連ストア。
  const downloadQuality = useSettings((s) => s.downloadQuality);
  const setDownloadQuality = useSettings((s) => s.setDownloadQuality);
  const rowMetaFields = useSettings((s) => s.rowMetaFields);
  const toggleRowMetaField = useSettings((s) => s.toggleRowMetaField);
  const artistGrouping = useSettings((s) => s.artistGrouping);
  const setArtistGrouping = useSettings((s) => s.setArtistGrouping);
  const downloadEntries = useDownloads((s) => s.entries);
  const downloadCount = Object.keys(downloadEntries).length;
  const downloadBytes = Object.values(downloadEntries).reduce(
    (sum, e) => sum + (e.bytes || 0),
    0,
  );

  // 永続化された設定/ダウンロード一覧を初回マウントで復元（冪等）。
  useEffect(() => {
    void useSettings.getState().hydrate();
    void useDownloads.getState().hydrate();
  }, []);

  const health = useQuery({
    queryKey: ["health", baseUrl],
    enabled: connected && client !== null,
    queryFn: ({ signal }) => client!.health(signal),
  });
  const stats = useQuery({
    queryKey: ["stats", baseUrl],
    enabled: connected && client !== null,
    queryFn: () => client!.stats(),
  });

  function handleReconnect() {
    if (!baseUrl) return;
    void useConnection.getState().connect(baseUrl, token);
  }

  async function handleDisconnect() {
    await useConnection.getState().disconnect();
    router.replace("/connect");
  }

  const statusColor =
    status === "connected"
      ? PALETTE.success
      : status === "error"
        ? PALETTE.danger
        : PALETTE.textDim;

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>設定</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>接続</Text>

          <Row label="状態">
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: statusColor }]} />
              <Text style={[styles.value, { color: statusColor }]}>
                {STATUS_LABEL[status] ?? status}
              </Text>
            </View>
          </Row>
          <Row label="サーバー">
            <Text style={styles.value}>{baseUrl ?? "（未設定）"}</Text>
          </Row>
          <Row label="トークン">
            <Text style={styles.value}>{maskToken(token)}</Text>
          </Row>
          {status === "error" && error ? (
            <Text style={styles.error}>{error}</Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              onPress={handleReconnect}
              disabled={!baseUrl || connecting}
              accessibilityRole="button"
              accessibilityLabel="再接続"
              style={({ pressed }) => [
                styles.btn,
                styles.btnPrimary,
                (!baseUrl || connecting) && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="refresh" size={18} color={BRAND.accentText} />
              <Text style={styles.btnPrimaryText}>再接続</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void handleDisconnect();
              }}
              accessibilityRole="button"
              accessibilityLabel="切断"
              style={({ pressed }) => [
                styles.btn,
                styles.btnGhost,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="log-out-outline" size={18} color={PALETTE.danger} />
              <Text style={styles.btnGhostText}>切断</Text>
            </Pressable>
          </View>
        </View>

        {connected ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>ライブラリ</Text>
            <Row label="サーバー名">
              <Text style={styles.value}>{health.data?.name ?? "…"}</Text>
            </Row>
            <Row label="バージョン">
              <Text style={styles.value}>{health.data?.version ?? "…"}</Text>
            </Row>
            <Row label="曲数">
              <Text style={styles.value}>
                {stats.data ? stats.data.trackCount.toLocaleString() : "…"}
              </Text>
            </Row>
            <Row label="プレイリスト数">
              <Text style={styles.value}>
                {stats.data ? stats.data.playlistCount.toLocaleString() : "…"}
              </Text>
            </Row>
            <Row label="総再生時間">
              <Text style={styles.value}>
                {stats.data ? formatDuration(stats.data.totalTimeMs) : "…"}
              </Text>
            </Row>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>オフライン</Text>

          <Text style={styles.fieldLabel}>ダウンロード品質</Text>
          <QualityPicker value={downloadQuality} onChange={setDownloadQuality} />

          <Pressable
            onPress={() => router.push("/downloads")}
            accessibilityRole="button"
            accessibilityLabel="ダウンロード管理"
            style={({ pressed }) => [styles.navRow, pressed && styles.pressed]}
          >
            <View>
              <Text style={styles.navLabel}>ダウンロード管理</Text>
              <Text style={styles.navSub}>
                {downloadCount}曲 ・ {formatBytes(downloadBytes)}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={PALETTE.textDim} />
          </Pressable>
        </View>

        {/* アーティストの束ね方 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>アーティストの束ね方</Text>
          <View style={styles.chipRow}>
            {(
              [
                { value: "artist", label: "アーティスト" },
                { value: "albumArtist", label: "アルバムアーティスト" },
              ] as { value: ArtistGrouping; label: string }[]
            ).map(({ value, label }) => {
              const active = artistGrouping === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setArtistGrouping(value)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={label}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>行に表示する情報</Text>
          <View style={styles.chipRow}>
            {META_FIELD_OPTIONS.map(({ field, label }) => {
              const active = rowMetaFields.includes(field);
              return (
                <Pressable
                  key={field}
                  onPress={() => toggleRowMetaField(field)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={label}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 16,
    // ミニプレイヤー（タブバー上に重なる ~60px）に最下部の項目が隠れないよう
    // 余白を確保する。他の一覧画面の listContent と同じ値に揃える。
    paddingBottom: 96,
  },
  heading: {
    color: PALETTE.text,
    fontSize: 28,
    fontWeight: "700",
  },
  card: {
    backgroundColor: PALETTE.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PALETTE.border,
    padding: 16,
    gap: 4,
  },
  cardTitle: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    gap: 12,
  },
  rowLabel: {
    color: PALETTE.textDim,
    fontSize: 14,
  },
  rowValue: {
    flexShrink: 1,
  },
  value: {
    color: PALETTE.text,
    fontSize: 15,
    textAlign: "right",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  error: {
    color: PALETTE.danger,
    fontSize: 13,
    paddingVertical: 4,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
  },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
  },
  btnPrimary: {
    backgroundColor: PALETTE.accent,
  },
  btnPrimaryText: {
    color: BRAND.accentText,
    fontWeight: "700",
    fontSize: 15,
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  btnGhostText: {
    color: PALETTE.danger,
    fontWeight: "600",
    fontSize: 15,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.7,
  },
  fieldLabel: {
    color: PALETTE.textDim,
    fontSize: 14,
    marginBottom: 8,
  },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surfaceAlt,
  },
  navLabel: {
    color: PALETTE.text,
    fontSize: 15,
    fontWeight: "600",
  },
  navSub: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.surfaceAlt,
  },
  chipActive: {
    backgroundColor: PALETTE.accent,
    borderColor: PALETTE.accent,
  },
  chipText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  chipTextActive: {
    color: BRAND.accentText,
  },
});
