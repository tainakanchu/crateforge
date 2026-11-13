// 未接続時のバナー（ライブラリ/プレイリスト/リモート共通）。
// 理由 1 行 + 復帰導線（トークン再入力 / 再試行 / 接続画面へ）を出す（round-2 M6）。

import { ActivityIndicator, Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useConnection } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import { REAUTH_HREF, connectionRecovery } from "@/lib/connectionStatus";

export interface ConnectionNoticeProps {
  /** 理由の後ろに添える補足（例: 「ダウンロード済み 3曲」）。 */
  suffix?: string | null;
}

export default function ConnectionNotice({ suffix }: ConnectionNoticeProps) {
  const router = useRouter();
  const status = useConnection((s) => s.status);
  const errorKind = useConnection((s) => s.errorKind);
  const checking = useConnection((s) => s.checking);
  const lastOkAt = useConnection((s) => s.lastOkAt);
  const baseUrl = useConnection((s) => s.baseUrl);
  const recovery = connectionRecovery({ status, errorKind, checking, lastOkAt, baseUrl });
  const busy = checking || status === "connecting";

  const onAction = () => {
    if (recovery.action === "reauth") router.push(REAUTH_HREF);
    else if (recovery.action === "retry") void useConnection.getState().recheck();
    else router.push("/connect");
  };

  return (
    <View style={styles.banner}>
      <View style={styles.textRow}>
        <Ionicons
          name={recovery.action === "reauth" ? "key-outline" : "cloud-offline-outline"}
          size={15}
          color={recovery.action === "reauth" ? PALETTE.danger : PALETTE.textDim}
        />
        <Text style={styles.reason} numberOfLines={2}>
          {recovery.reason}
          {suffix ? ` ・ ${suffix}` : ""}
        </Text>
      </View>
      <Pressable
        onPress={onAction}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={recovery.actionLabel}
        accessibilityState={{ disabled: busy }}
        style={({ pressed }) => [styles.action, busy && styles.actionBusy, pressed && styles.pressed]}
      >
        {busy && recovery.action === "retry" ? (
          <ActivityIndicator size="small" color={BRAND.accentText} />
        ) : (
          <Text style={styles.actionText}>{recovery.actionLabel}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  textRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  reason: {
    flex: 1,
    color: PALETTE.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  action: {
    flexShrink: 0,
    minHeight: 32,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: PALETTE.accent,
  },
  actionBusy: {
    opacity: 0.6,
  },
  actionText: {
    color: BRAND.accentText,
    fontSize: 13,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.7,
  },
});
