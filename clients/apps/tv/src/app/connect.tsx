// Crateforge TV ペアリング画面。
// TV にはカメラがないため QR ではなく数字コード入力でペアリングする。
// 1. デスクトップの IP:port を入力
// 2. "ペアリング開始" → POST /api/pair/start → コードを大きく表示
// 3. ユーザーがデスクトップ側「設定 → モバイル / API → 端末を承認」にコードを入力
// 4. GET /api/pair/poll をポーリングして approved になったら接続完了

import { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Device from "expo-device";
import {
  isAvailable as mdnsIsAvailable,
  startDiscovery,
  stopDiscovery,
  addServiceFoundListener,
  type DiscoveredService,
} from "expo-crateforge-mdns";

import {
  ApiClient,
  DESKTOP_PAIR_APPROVE_PATH,
  PAIRING_EXPIRED_MESSAGE,
  type PairingSession,
  dedupeDiscovered,
  describeApiError,
  discoveredKey,
  startPairingSession,
  useConnection,
} from "@crateforge/core";
import { PALETTE, TV_FONT, FOCUS_RING } from "@/theme/palette";

type Phase = "input" | "polling" | "error";

// ネイティブ mDNS モジュールが使えるか（Expo Go / web / 旧 dev build では false）。
// false のときは探索 UI を出さず、従来どおり IP:port の手入力のみで動かす。
const DISCOVERY_AVAILABLE = mdnsIsAvailable();

// Android TV の Gboard は全角固定になりがちで、IP:port が全角で入力されると接続に失敗する。
// 入力時に全角英数字/記号（U+FF01..U+FF5E）と全角スペース（U+3000）を半角へ正規化する。
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

export default function ConnectScreen() {
  const [address, setAddress] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [code, setCode] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addressFocused, setAddressFocused] = useState(false);
  const [btnFocused, setBtnFocused] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredService[]>([]);
  const [discoveredFocusKey, setDiscoveredFocusKey] = useState<string | null>(null);
  // 進行中のペアリング（core の状態機械）。cancel でポーリングごと止まる。
  const pairingRef = useRef<PairingSession | null>(null);

  const stopPolling = useCallback(() => {
    pairingRef.current?.cancel();
    pairingRef.current = null;
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // mDNS 探索: フォームが出ている間（polling 以外）だけ走らせる。
  // ネイティブが無ければ何もしない（startDiscovery 等は no-op）。
  // polling に入ると cleanup で stopDiscovery され、戻ると再開する。
  useEffect(() => {
    if (!DISCOVERY_AVAILABLE || phase === "polling") return;
    startDiscovery();
    const sub = addServiceFoundListener((svc) => {
      setDiscovered((prev) => dedupeDiscovered(prev, svc));
    });
    return () => {
      sub.remove();
      stopDiscovery();
    };
  }, [phase]);

  // pairStart → コード表示 → 承認確認のポーリング（core の pairingSession）。
  const startPairing = useCallback(
    (rawAddress: string) => {
      const trimmed = rawAddress.trim();
      if (!trimmed) {
        setErrorMsg("デスクトップの IP:port を入力してください（例: 192.168.1.10:8787）");
        setPhase("error");
        return;
      }

      stopPolling();
      setPhase("polling");
      setErrorMsg(null);

      const fail = (message: string) => {
        setPhase("error");
        setErrorMsg(message);
        setCode(null);
      };

      let client: ApiClient;
      try {
        client = new ApiClient({ baseUrl: trimmed, token: null });
      } catch (e) {
        fail(describeApiError(e, { action: "接続" }));
        return;
      }
      pairingRef.current = startPairingSession({
        client,
        deviceName: Device.deviceName ?? Device.modelName ?? "Android TV",
        platform: "android-tv",
        onEvent: (ev) => {
          if (ev.type === "code") {
            setCode(ev.code);
          } else if (ev.type === "approved") {
            // Gate が / へリダイレクトする
            void useConnection.getState().connect(trimmed, ev.token);
          } else if (ev.type === "expired") {
            fail(PAIRING_EXPIRED_MESSAGE);
          } else {
            // 文言は mobile と同じ describeApiError（原因と対処を添える）。
            fail(describeApiError(ev.error, { action: ev.stage === "start" ? "接続" : "承認の確認" }));
          }
        },
      });
    },
    [stopPolling],
  );

  const handleStart = useCallback(() => {
    startPairing(address);
  }, [address, startPairing]);

  // 探索結果を選んだら探索を止め、その IP:port でペアリングを開始する。
  const handlePickDiscovered = useCallback(
    (svc: DiscoveredService) => {
      const addr = discoveredKey(svc);
      stopDiscovery();
      setAddress(addr);
      startPairing(addr);
    },
    [startPairing],
  );

  const handleRetry = useCallback(() => {
    stopPolling();
    setPhase("input");
    setCode(null);
    setErrorMsg(null);
    setDiscovered([]);
  }, [stopPolling]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Crateforge TV</Text>
        <Text style={styles.subtitle}>デスクトップとペアリング</Text>

        {phase !== "polling" && (
          <>
            <Text style={styles.label}>デスクトップの IP:port</Text>
            <TextInput
              style={[styles.input, addressFocused && FOCUS_RING]}
              value={address}
              onChangeText={(t) => setAddress(toHalfWidth(t))}
              placeholder="192.168.1.10:8787"
              placeholderTextColor={PALETTE.textSub}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              onFocus={() => setAddressFocused(true)}
              onBlur={() => setAddressFocused(false)}
            />
            <Pressable
              style={[styles.button, btnFocused && styles.buttonFocused]}
              onPress={handleStart}
              onFocus={() => setBtnFocused(true)}
              onBlur={() => setBtnFocused(false)}
              hasTVPreferredFocus
            >
              <Text style={styles.buttonText}>ペアリング開始</Text>
            </Pressable>

            {DISCOVERY_AVAILABLE && (
              <View style={styles.discoverBox}>
                <Text style={styles.discoverLabel}>近くのサーバー</Text>
                {discovered.length === 0 ? (
                  <Text style={styles.discoverHint}>同じ LAN を検索中…</Text>
                ) : (
                  discovered.map((svc) => {
                    const key = discoveredKey(svc);
                    const focused = discoveredFocusKey === key;
                    return (
                      <Pressable
                        key={key}
                        style={[styles.discoverItem, focused && styles.discoverItemFocused]}
                        onPress={() => handlePickDiscovered(svc)}
                        onFocus={() => setDiscoveredFocusKey(key)}
                        onBlur={() =>
                          setDiscoveredFocusKey((k) => (k === key ? null : k))
                        }
                      >
                        <Text style={styles.discoverItemName}>{svc.name}</Text>
                        <Text style={styles.discoverItemAddr}>{key}</Text>
                      </Pressable>
                    );
                  })
                )}
              </View>
            )}
          </>
        )}

        {phase === "polling" && (
          <View style={styles.codeBox}>
            <Text style={styles.codeLabel}>
              {code ? "デスクトップで承認してください" : "接続中…"}
            </Text>
            {code ? (
              <>
                <Text style={styles.code}>{code}</Text>
                <Text style={styles.codeInstructions}>
                  デスクトップの{"\n"}「{DESKTOP_PAIR_APPROVE_PATH}」に{"\n"}このコードを入力してください
                </Text>
                <ActivityIndicator color={PALETTE.teal} size="large" style={{ marginTop: 32 }} />
                <Text style={styles.polling}>承認待ち中…</Text>
              </>
            ) : (
              // コードが届くまで（pairStart の応答待ち）は空白にせずスピナーを出す（mobile と同じ）。
              <ActivityIndicator color={PALETTE.teal} size="large" style={{ marginVertical: 32 }} />
            )}
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={handleRetry}>
              <Text style={styles.buttonText}>やり直す</Text>
            </Pressable>
          </View>
        )}

        {phase === "error" && errorMsg && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMsg}</Text>
            <Pressable
              style={[styles.button, btnFocused && styles.buttonFocused]}
              onPress={handleRetry}
              onFocus={() => setBtnFocused(true)}
              onBlur={() => setBtnFocused(false)}
              hasTVPreferredFocus
            >
              <Text style={styles.buttonText}>もう一度試す</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: PALETTE.bg,
  },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 64,
  },
  title: {
    fontSize: TV_FONT.hero,
    fontWeight: "700",
    color: PALETTE.teal,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: TV_FONT.md,
    color: PALETTE.textSub,
    marginBottom: 64,
  },
  label: {
    fontSize: TV_FONT.sm,
    color: PALETTE.text,
    alignSelf: "flex-start",
    marginBottom: 8,
    width: "100%",
    maxWidth: 600,
  },
  input: {
    width: "100%",
    maxWidth: 600,
    backgroundColor: PALETTE.surface,
    color: PALETTE.text,
    fontSize: TV_FONT.md,
    padding: 20,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: PALETTE.border,
    marginBottom: 32,
  },
  button: {
    backgroundColor: PALETTE.teal,
    paddingVertical: 20,
    paddingHorizontal: 64,
    borderRadius: 8,
    marginTop: 8,
    borderWidth: 3,
    borderColor: "transparent",
  },
  buttonFocused: {
    borderColor: PALETTE.text,
    backgroundColor: "#4A8BA5",
  },
  secondaryButton: {
    backgroundColor: PALETTE.surface,
    marginTop: 24,
  },
  buttonText: {
    color: PALETTE.text,
    fontSize: TV_FONT.md,
    fontWeight: "600",
    textAlign: "center",
  },
  codeBox: {
    alignItems: "center",
    gap: 16,
  },
  codeLabel: {
    fontSize: TV_FONT.md,
    color: PALETTE.textSub,
    marginBottom: 8,
  },
  code: {
    fontSize: TV_FONT.hero,
    fontWeight: "900",
    color: PALETTE.teal,
    letterSpacing: 16,
    fontVariant: ["tabular-nums"],
  },
  codeInstructions: {
    fontSize: TV_FONT.sm,
    color: PALETTE.text,
    textAlign: "center",
    lineHeight: 36,
  },
  polling: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    marginTop: 8,
  },
  discoverBox: {
    width: "100%",
    maxWidth: 600,
    marginTop: 40,
    gap: 12,
  },
  discoverLabel: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
  },
  discoverHint: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    paddingVertical: 12,
  },
  discoverItem: {
    backgroundColor: PALETTE.surface,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: "transparent",
    paddingVertical: 18,
    paddingHorizontal: 24,
  },
  discoverItemFocused: {
    borderColor: PALETTE.teal,
    backgroundColor: PALETTE.focusBg,
  },
  discoverItemName: {
    fontSize: TV_FONT.md,
    color: PALETTE.text,
    fontWeight: "600",
  },
  discoverItemAddr: {
    fontSize: TV_FONT.xs,
    color: PALETTE.textSub,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  errorBox: {
    alignItems: "center",
    gap: 24,
  },
  errorText: {
    fontSize: TV_FONT.sm,
    color: "#E57373",
    textAlign: "center",
    maxWidth: 600,
  },
});
