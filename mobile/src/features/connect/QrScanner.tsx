// デスクトップが表示する接続 QR をカメラで読む。
// QR は "http://<ip>:<port>/?token=<token>" 形式。origin を baseUrl、token をクエリから取り出す。

import { useState } from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import type { BarcodeScanningResult } from "expo-camera";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";

import IconButton from "@/components/IconButton";
import { BRAND, PALETTE } from "@/constants/brand";

export interface QrScannerProps {
  /** QR の生データ（文字列）を受け取る。 */
  onScanned: (data: string) => void;
  /** スキャナを閉じる。 */
  onClose: () => void;
}

/**
 * 接続 QR をパースする。"http://192.168.1.5:8787/?token=abc" →
 * { baseUrl: "http://192.168.1.5:8787", token: "abc" }。
 * token 無しなら token=null、解釈不能なら null を返す（防御的）。
 */
export function parseConnectionQr(
  data: string,
): { baseUrl: string; token: string | null } | null {
  const raw = (data ?? "").trim();
  if (raw === "") return null;

  // グローバル URL があれば優先（origin が確実に取れる）。
  const Url = (globalThis as { URL?: typeof URL }).URL;
  if (typeof Url === "function") {
    try {
      const u = new Url(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (!u.host) return null;
      const token = u.searchParams.get("token");
      return { baseUrl: u.origin, token: token && token !== "" ? token : null };
    } catch {
      // URL が使えない/不正 → 手動パースにフォールバック。
    }
  }

  // 手動パース。scheme://host[:port][/path][?query]
  const m = /^(https?):\/\/([^/?#]+)/i.exec(raw);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2];
  if (host === "") return null;
  const baseUrl = `${scheme}://${host}`;

  // token クエリを抽出。
  const q = /[?&]token=([^&#]*)/.exec(raw);
  let token: string | null = null;
  if (q) {
    try {
      token = decodeURIComponent(q[1]);
    } catch {
      token = q[1];
    }
    if (token === "") token = null;
  }
  return { baseUrl, token };
}

export default function QrScanner({ onScanned, onClose }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  // 多重発火を防ぐ（onBarcodeScanned は連続で呼ばれる）。
  const [done, setDone] = useState(false);

  function handleScanned(data: string) {
    if (done) return;
    setDone(true);
    onScanned(data);
  }

  // 権限の問い合わせ前（permission===null）はローディング相当の枠。
  if (!permission) {
    return (
      <View style={styles.fill}>
        <Header onClose={onClose} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.fill}>
        <Header onClose={onClose} />
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={48} color={PALETTE.textFaint} />
          <Text style={styles.permText}>
            QR をスキャンするにはカメラの許可が必要です
          </Text>
          <Pressable
            onPress={() => {
              void requestPermission();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>カメラを許可</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }: BarcodeScanningResult) => handleScanned(data)}
      />
      <Header onClose={onClose} />
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.reticle} />
        <Text style={styles.hint}>デスクトップの QR を枠に合わせてください</Text>
      </View>
    </View>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.header}>
      <IconButton name="close" onPress={onClose} accessibilityLabel="閉じる" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    justifyContent: "flex-end",
    padding: 8,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  permText: {
    color: PALETTE.textDim,
    fontSize: 15,
    textAlign: "center",
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
  },
  reticle: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: PALETTE.accent,
    borderRadius: 16,
    backgroundColor: "transparent",
  },
  hint: {
    color: PALETTE.text,
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.accent,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonText: {
    color: BRAND.accentText,
    fontWeight: "700",
    fontSize: 15,
  },
});
