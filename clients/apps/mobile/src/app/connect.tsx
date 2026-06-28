// Connect 画面。手入力（URL + token）・QR スキャン・mDNS 発見ホスト選択の 3 通りでサーバーに接続する。
// 発見ホスト選択時はトークン不要のペアリングフロー（pairStart→コード表示→pairPoll→接続）に入る。
// 接続成功後の遷移は _layout の Gate が担う（status==='connected' で / へ）。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Device from "expo-device";
import {
  isAvailable as mdnsIsAvailable,
  startDiscovery,
  stopDiscovery,
  addServiceFoundListener,
  type DiscoveredService,
} from "expo-crateforge-mdns";

import Screen from "@/components/Screen";
import { BRAND, PALETTE } from "@/constants/brand";
import { ApiClient, useConnection, useDownloads } from "@crateforge/core";
import QrScanner, { parseConnectionQr } from "@/features/connect/QrScanner";

// ネイティブ mDNS モジュールが使えるか（Expo Go / web では false）。
// false のときは探索 UI を出さず、従来どおり手入力 URL + QR で接続する。
const DISCOVERY_AVAILABLE = mdnsIsAvailable();

type PairingPhase = "idle" | "pairing" | "pairError";

export default function ConnectScreen() {
  const status = useConnection((s) => s.status);
  const router = useRouter();
  const hasDownloads = useDownloads((s) => Object.keys(s.entries).length > 0);
  const error = useConnection((s) => s.error);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredService[]>([]);

  // ペアリングフロー状態（発見ホスト選択時に使う）
  const [pairingPhase, setPairingPhase] = useState<PairingPhase>("idle");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBaseUrl, setPairingBaseUrl] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairClientRef = useRef<ApiClient | null>(null);

  const connecting = status === "connecting";

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current != null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // アンマウント時にポーリングを確実に止める
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // mDNS 探索: ペアリング中以外に走らせる。ネイティブが無ければ何もしない。
  useEffect(() => {
    if (!DISCOVERY_AVAILABLE || pairingPhase !== "idle") return;
    startDiscovery();
    const sub = addServiceFoundListener((svc) => {
      setDiscovered((prev) => {
        const key = `${svc.host}:${svc.port}`;
        if (prev.some((s) => `${s.host}:${s.port}` === key)) return prev;
        return [...prev, svc];
      });
    });
    return () => {
      sub.remove();
      stopDiscovery();
    };
  }, [pairingPhase]);

  function connect(rawUrl: string, rawToken: string | null) {
    void useConnection.getState().connect(rawUrl, rawToken && rawToken !== "" ? rawToken : null);
  }

  function handleConnect() {
    connect(url, token);
  }

  // ペアリングフロー開始: 発見ホストのアドレスで pairStart → code 表示 → pairPoll。
  const startPairing = useCallback(
    async (rawAddr: string) => {
      const baseUrl = rawAddr.trim();
      setPairingPhase("pairing");
      setPairingError(null);
      setPairingCode(null);
      setPairingBaseUrl(baseUrl);

      try {
        const client = new ApiClient({ baseUrl, token: null });
        pairClientRef.current = client;
        const deviceName = Device.deviceName ?? Device.modelName ?? "Mobile";
        const platform = Platform.OS === "ios" ? "ios" : "android";
        const { session, code } = await client.pairStart(deviceName, platform);
        sessionRef.current = session;
        setPairingCode(code);

        // 2秒ごとにポーリング
        pollTimerRef.current = setInterval(() => {
          void (async () => {
            try {
              if (!sessionRef.current || !pairClientRef.current) return;
              const res = await pairClientRef.current.pairPoll(sessionRef.current);
              if (res.status === "approved" && res.token != null) {
                stopPolling();
                await useConnection.getState().connect(baseUrl, res.token);
                // Gate が / へリダイレクトする
              } else if (res.status === "expired") {
                stopPolling();
                setPairingPhase("pairError");
                setPairingError("コードが期限切れになりました。もう一度お試しください。");
                setPairingCode(null);
              }
            } catch (e) {
              stopPolling();
              setPairingPhase("pairError");
              setPairingError(e instanceof Error ? e.message : "ポーリングエラー");
              setPairingCode(null);
            }
          })();
        }, 2000);
      } catch (e) {
        setPairingPhase("pairError");
        setPairingError(e instanceof Error ? e.message : "接続できませんでした");
      }
    },
    [stopPolling],
  );

  // ペアリングをキャンセルしてフォームに戻る。
  const cancelPairing = useCallback(() => {
    stopPolling();
    setPairingPhase("idle");
    setPairingCode(null);
    setPairingError(null);
    setPairingBaseUrl(null);
    sessionRef.current = null;
    pairClientRef.current = null;
    setDiscovered([]);
  }, [stopPolling]);

  function handlePickDiscovered(svc: DiscoveredService) {
    stopDiscovery();
    const addr = `${svc.host}:${svc.port}`;
    void startPairing(addr);
  }

  function handleScanned(data: string) {
    setScanning(false);
    const parsed = parseConnectionQr(data);
    if (!parsed) {
      // パース不能。手入力欄に生データを残してユーザーに委ねる。
      setUrl(data);
      return;
    }
    setUrl(parsed.baseUrl);
    setToken(parsed.token ?? "");
    connect(parsed.baseUrl, parsed.token);
  }

  return (
    <Screen style={styles.root}>
      <View style={styles.brand}>
        <Ionicons name="disc" size={48} color={PALETTE.accent} />
        <Text style={styles.title}>Crateforge に接続</Text>
        <Text style={styles.subtitle}>同じ LAN のデスクトップへ接続します</Text>
      </View>

      {pairingPhase === "idle" ? (
        <View style={styles.form}>
          <Text style={styles.fieldLabel}>サーバー URL</Text>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="192.168.x.x:8787"
            placeholderTextColor={PALETTE.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!connecting}
            style={styles.input}
            accessibilityLabel="サーバー URL"
          />

          <Text style={styles.fieldLabel}>トークン（任意）</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="X-API-Token"
            placeholderTextColor={PALETTE.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!connecting}
            style={styles.input}
            accessibilityLabel="トークン"
          />

          {status === "error" && error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            onPress={handleConnect}
            disabled={connecting}
            accessibilityRole="button"
            accessibilityLabel="接続"
            style={({ pressed }) => [
              styles.primary,
              connecting && styles.primaryDisabled,
              pressed && !connecting && styles.pressed,
            ]}
          >
            {connecting ? (
              <ActivityIndicator color={BRAND.accentText} />
            ) : (
              <Text style={styles.primaryText}>接続</Text>
            )}
          </Pressable>

          <View style={styles.divider}>
            <View style={styles.line} />
            <Text style={styles.or}>または</Text>
            <View style={styles.line} />
          </View>

          <Pressable
            onPress={() => setScanning(true)}
            disabled={connecting}
            accessibilityRole="button"
            accessibilityLabel="QR をスキャン"
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Ionicons name="qr-code-outline" size={20} color={PALETTE.accent} />
            <Text style={styles.secondaryText}>QR をスキャン</Text>
          </Pressable>

          {DISCOVERY_AVAILABLE ? (
            <View style={styles.discoverSection}>
              <Text style={styles.discoverHeader}>近くのサーバー</Text>
              {discovered.length === 0 ? (
                <Text style={styles.discoverHint}>同じ Wi-Fi を検索中…</Text>
              ) : (
                discovered.map((svc) => {
                  const key = `${svc.host}:${svc.port}`;
                  return (
                    <Pressable
                      key={key}
                      onPress={() => handlePickDiscovered(svc)}
                      disabled={connecting}
                      accessibilityRole="button"
                      accessibilityLabel={`${svc.name} (${key}) に接続`}
                      style={({ pressed }) => [
                        styles.discoverItem,
                        pressed && !connecting && styles.pressed,
                      ]}
                    >
                      <Ionicons name="desktop-outline" size={18} color={PALETTE.accent} />
                      <View style={styles.discoverItemBody}>
                        <Text style={styles.discoverItemName}>{svc.name}</Text>
                        <Text style={styles.discoverItemAddr}>{key}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={PALETTE.textFaint} />
                    </Pressable>
                  );
                })
              )}
            </View>
          ) : null}

          {hasDownloads ? (
            <Pressable
              onPress={() => router.replace("/")}
              accessibilityRole="button"
              accessibilityLabel="ダウンロード済みを再生（サーバーなし）"
              style={({ pressed }) => [styles.offlineLink, pressed && styles.pressed]}
            >
              <Ionicons name="cloud-offline-outline" size={18} color={PALETTE.textDim} />
              <Text style={styles.offlineLinkText}>ダウンロード済みを再生</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.pairingBox}>
          {pairingPhase === "pairing" && (
            <>
              <Text style={styles.pairingLabel}>
                {pairingCode ? "デスクトップで承認してください" : "接続中…"}
              </Text>
              {pairingCode ? (
                <>
                  <Text style={styles.pairingCode}>{pairingCode}</Text>
                  <Text style={styles.pairingInstructions}>
                    デスクトップの{"\n"}「設定 → API → 端末を承認」に{"\n"}このコードを入力してください
                  </Text>
                  {pairingBaseUrl ? (
                    <Text style={styles.pairingAddr}>{pairingBaseUrl}</Text>
                  ) : null}
                  <ActivityIndicator color={PALETTE.accent} size="small" style={{ marginTop: 8 }} />
                  <Text style={styles.pairingPolling}>承認待ち中…</Text>
                </>
              ) : (
                <ActivityIndicator color={PALETTE.accent} style={{ marginVertical: 32 }} />
              )}
              <Pressable
                onPress={cancelPairing}
                accessibilityRole="button"
                accessibilityLabel="キャンセル"
                style={({ pressed }) => [styles.secondary, styles.pairingCancel, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>キャンセル</Text>
              </Pressable>
            </>
          )}
          {pairingPhase === "pairError" && (
            <>
              <Ionicons name="warning-outline" size={48} color={PALETTE.danger} />
              <Text style={styles.pairingErrorText}>{pairingError}</Text>
              <Pressable
                onPress={cancelPairing}
                accessibilityRole="button"
                accessibilityLabel="もう一度試す"
                style={({ pressed }) => [styles.primary, styles.pairingRetry, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>もう一度試す</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      <Modal
        visible={scanning}
        animationType="slide"
        onRequestClose={() => setScanning(false)}
      >
        <QrScanner onScanned={handleScanned} onClose={() => setScanning(false)} />
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 24,
    justifyContent: "center",
  },
  brand: {
    alignItems: "center",
    gap: 8,
    marginBottom: 36,
  },
  title: {
    color: PALETTE.text,
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: PALETTE.textDim,
    fontSize: 14,
  },
  form: {
    gap: 10,
  },
  fieldLabel: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginTop: 4,
  },
  input: {
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: PALETTE.text,
    fontSize: 16,
  },
  error: {
    color: PALETTE.danger,
    fontSize: 14,
    marginTop: 4,
  },
  primary: {
    marginTop: 12,
    backgroundColor: PALETTE.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 50,
  },
  primaryDisabled: {
    opacity: 0.6,
  },
  primaryText: {
    color: BRAND.accentText,
    fontSize: 16,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.7,
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 16,
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: PALETTE.border,
  },
  or: {
    color: PALETTE.textFaint,
    fontSize: 13,
  },
  secondary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: PALETTE.border,
    borderRadius: 10,
    paddingVertical: 13,
  },
  secondaryText: {
    color: PALETTE.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  discoverSection: {
    marginTop: 20,
    gap: 8,
  },
  discoverHeader: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginBottom: 2,
  },
  discoverHint: {
    color: PALETTE.textFaint,
    fontSize: 13,
    paddingVertical: 6,
  },
  discoverItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  discoverItemBody: {
    flex: 1,
  },
  discoverItemName: {
    color: PALETTE.text,
    fontSize: 15,
    fontWeight: "600",
  },
  discoverItemAddr: {
    color: PALETTE.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  offlineLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
    paddingVertical: 12,
  },
  offlineLinkText: {
    color: PALETTE.textDim,
    fontSize: 14,
    fontWeight: "600",
  },
  // ペアリングフロー UI
  pairingBox: {
    alignItems: "center",
    gap: 16,
    paddingVertical: 16,
  },
  pairingLabel: {
    color: PALETTE.textDim,
    fontSize: 16,
    textAlign: "center",
  },
  pairingCode: {
    color: PALETTE.accent,
    fontSize: 56,
    fontWeight: "900",
    letterSpacing: 12,
    fontVariant: ["tabular-nums"],
    marginVertical: 8,
  },
  pairingInstructions: {
    color: PALETTE.text,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  pairingAddr: {
    color: PALETTE.textFaint,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  pairingPolling: {
    color: PALETTE.textFaint,
    fontSize: 13,
  },
  pairingCancel: {
    marginTop: 8,
    paddingHorizontal: 32,
  },
  pairingErrorText: {
    color: PALETTE.danger,
    fontSize: 15,
    textAlign: "center",
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 16,
  },
  pairingRetry: {
    paddingHorizontal: 48,
    marginTop: 8,
  },
});
