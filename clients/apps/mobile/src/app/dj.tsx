// DJ モード画面（フルスクリーン・スタックルート）。
// 2 デッキ（expo-audio プレイヤー × 2）＋クロスフェーダーの簡易 DJ。
// - マウント時: メインプレイヤーを停止し、DJ エンジンを差し込み、MIDI 受信を開始。
// - アンマウント時: MIDI 停止・エンジン解放（デッキのロード内容は次回復元される）。
// - MIDI は expo-crateforge-midi（Android + USB OTG）。割り当ては MidiPanel のラーンで行う。

import { useEffect, useState } from "react";
import { ScrollView, Pressable, Text, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Midi from "expo-crateforge-midi";
import type { MidiDeviceDescriptor } from "expo-crateforge-midi";

import { usePlayer, type Track } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import Screen from "@/components/Screen";
import IconButton from "@/components/IconButton";
import DeckPanel from "@/features/dj/DeckPanel";
import FaderBar from "@/features/dj/FaderBar";
import TrackPickerModal from "@/features/dj/TrackPickerModal";
import MidiPanel from "@/features/dj/MidiPanel";
import { createDjEngine } from "@/features/dj/engine";
import type { DeckId } from "@/features/dj/math";
import { useDj } from "@/features/dj/store";
import { useDjMidi } from "@/features/dj/midi";

export default function DjScreen() {
  const router = useRouter();
  const [pickerDeck, setPickerDeck] = useState<DeckId | null>(null);
  const [midiOpen, setMidiOpen] = useState(false);
  const [midiAvailable, setMidiAvailable] = useState(false);
  const [devices, setDevices] = useState<MidiDeviceDescriptor[]>([]);

  const crossfader = useDj((s) => s.crossfader);
  const setCrossfader = useDj((s) => s.setCrossfader);
  const lastError = useDj((s) => s.lastError);
  const clearError = useDj((s) => s.clearError);
  const loadTrack = useDj((s) => s.loadTrack);

  useEffect(() => {
    // 端末単体で 2 系統も鳴らすため、通常のライブラリ再生は止めてから始める。
    usePlayer.getState().pause();
    useDj.getState().setEngine(createDjEngine());

    // MIDI: マッピング復元 → 受信開始 → ストアへディスパッチ。
    void useDjMidi.getState().hydrate();
    setMidiAvailable(Midi.isAvailable());
    setDevices(Midi.listDevices());
    Midi.start();
    const messageSub = Midi.addMidiMessageListener((m) =>
      useDjMidi.getState().handleMessage(m),
    );
    const devicesSub = Midi.addDevicesChangedListener((p) => setDevices(p.devices));

    return () => {
      messageSub.remove();
      devicesSub.remove();
      Midi.stop();
      useDj.getState().shutdown();
    };
  }, []);

  const onPick = (deck: DeckId, track: Track) => {
    loadTrack(deck, track);
    setPickerDeck(null);
  };

  const midiConnected = midiAvailable && devices.some((d) => d.outputPorts > 0);

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton name="chevron-down" onPress={() => router.back()} accessibilityLabel="DJ モードを閉じる" />
        <Text style={styles.headerTitle}>DJ</Text>
        <Pressable
          onPress={() => setMidiOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="MIDI 設定"
          style={({ pressed }) => [styles.midiBtn, pressed && styles.pressed]}
        >
          <Ionicons
            name="musical-notes"
            size={18}
            color={midiConnected ? BRAND.accent : PALETTE.textDim}
          />
          <Text style={[styles.midiBtnText, midiConnected && styles.midiBtnTextOn]}>
            MIDI
          </Text>
        </Pressable>
      </View>

      {lastError != null ? (
        <Pressable onPress={clearError} style={styles.errorBanner} accessibilityRole="button">
          <Text style={styles.errorText} numberOfLines={2}>
            デッキ{lastError.deck === "a" ? "A" : "B"}: {lastError.message}
          </Text>
        </Pressable>
      ) : null}

      <ScrollView contentContainerStyle={styles.content}>
        <DeckPanel deck="a" onRequestLoad={setPickerDeck} />

        {/* クロスフェーダー */}
        <View style={styles.xfaderWrap}>
          <FaderBar
            value={crossfader}
            onChange={setCrossfader}
            startLabel="A"
            endLabel="B"
            fillFrom="center"
            accessibilityLabel="クロスフェーダー"
          />
        </View>

        <DeckPanel deck="b" onRequestLoad={setPickerDeck} />
      </ScrollView>

      <TrackPickerModal deck={pickerDeck} onClose={() => setPickerDeck(null)} onPick={onPick} />
      <MidiPanel
        visible={midiOpen}
        onClose={() => setMidiOpen(false)}
        midiAvailable={midiAvailable}
        devices={devices}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  headerTitle: {
    color: PALETTE.text,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 2,
  },
  midiBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
  },
  midiBtnText: {
    color: PALETTE.textDim,
    fontSize: 12,
    fontWeight: "700",
  },
  midiBtnTextOn: {
    color: BRAND.accent,
  },
  errorBanner: {
    marginHorizontal: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PALETTE.danger,
  },
  errorText: {
    color: PALETTE.danger,
    fontSize: 12,
  },
  content: {
    padding: 12,
    gap: 10,
  },
  xfaderWrap: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  pressed: {
    opacity: 0.7,
  },
});
