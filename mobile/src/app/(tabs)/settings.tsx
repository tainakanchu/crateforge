// Settings 画面。現在の接続情報（baseUrl / token マスク）と状態を表示し、
// 再接続・切断を行う。接続中ならサーバー/ライブラリ情報も表示する。

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import Screen from "@/components/Screen";
import { BRAND, PALETTE } from "@/constants/brand";
import { formatDuration } from "@/lib/format";
import { useConnection } from "@/store/connection";

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

export default function SettingsScreen() {
  const router = useRouter();
  const baseUrl = useConnection((s) => s.baseUrl);
  const token = useConnection((s) => s.token);
  const status = useConnection((s) => s.status);
  const error = useConnection((s) => s.error);
  const client = useConnection((s) => s.client);

  const connected = status === "connected";
  const connecting = status === "connecting";

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
});
