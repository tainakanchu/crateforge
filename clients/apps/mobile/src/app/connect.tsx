// Connect 画面。手入力（URL + token）と QR スキャンの 2 通りでサーバーに接続する。
// 接続成功後の遷移は _layout の Gate が担う（status==='connected' で / へ）。

import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import Screen from "@/components/Screen";
import { BRAND, PALETTE } from "@/constants/brand";
import { useConnection } from "@crateforge/core";
import QrScanner, { parseConnectionQr } from "@/features/connect/QrScanner";

export default function ConnectScreen() {
  const status = useConnection((s) => s.status);
  const error = useConnection((s) => s.error);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);

  const connecting = status === "connecting";

  function connect(rawUrl: string, rawToken: string | null) {
    void useConnection.getState().connect(rawUrl, rawToken && rawToken !== "" ? rawToken : null);
  }

  function handleConnect() {
    connect(url, token);
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
      </View>

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
});
