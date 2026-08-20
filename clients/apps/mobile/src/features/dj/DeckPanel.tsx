// DJ デッキ 1 台分のパネル。トラック情報 / シーク / CUE / PLAY / SYNC / ナッジ /
// テンポフェーダー / チャンネルフェーダーを縦にまとめる。状態は useDj から購読する。

import { Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { trackArtist, trackTitle } from "@crateforge/core";
import { BRAND, PALETTE } from "@/constants/brand";
import SeekBar from "@/features/remote/SeekBar";

import FaderBar from "./FaderBar";
import {
  type DeckId,
  NUDGE_DOWN,
  NUDGE_UP,
  effectiveBpm,
  formatTempoPercent,
  tempoToRate,
} from "./math";
import { useDj } from "./store";

export interface DeckPanelProps {
  deck: DeckId;
  /** LOAD ボタン押下（トラックピッカーを開く）。 */
  onRequestLoad: (deck: DeckId) => void;
}

export default function DeckPanel({ deck, onRequestLoad }: DeckPanelProps) {
  const d = useDj((s) => s.decks[deck]);
  const tempoRange = useDj((s) => s.tempoRange);
  const togglePlay = useDj((s) => s.togglePlay);
  const pressCue = useDj((s) => s.pressCue);
  const sync = useDj((s) => s.sync);
  const seek = useDj((s) => s.seek);
  const setTempo = useDj((s) => s.setTempo);
  const setVolume = useDj((s) => s.setVolume);
  const setNudge = useDj((s) => s.setNudge);
  const cycleTempoRange = useDj((s) => s.cycleTempoRange);

  const deckLabel = deck === "a" ? "A" : "B";
  const rate = tempoToRate(d.tempo, tempoRange);
  const effBpm = effectiveBpm(d.track?.bpm ?? null, rate);
  const hasTrack = d.track != null;

  return (
    <View style={styles.panel}>
      {/* ヘッダ行: デッキ名 / 曲情報 / LOAD */}
      <View style={styles.headerRow}>
        <View style={styles.deckBadge}>
          <Text style={styles.deckBadgeText}>{deckLabel}</Text>
        </View>
        <View style={styles.trackInfo}>
          {hasTrack ? (
            <>
              <Text style={styles.title} numberOfLines={1}>
                {trackTitle(d.track!)}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {trackArtist(d.track!)}
              </Text>
            </>
          ) : (
            <Text style={styles.emptyText}>曲を LOAD してください</Text>
          )}
        </View>
        <Pressable
          onPress={() => onRequestLoad(deck)}
          accessibilityRole="button"
          accessibilityLabel={`デッキ${deckLabel}に曲をロード`}
          style={({ pressed }) => [styles.loadBtn, pressed && styles.pressed]}
        >
          <Ionicons name="download-outline" size={14} color={PALETTE.text} />
          <Text style={styles.loadBtnText}>LOAD</Text>
        </Pressable>
      </View>

      {/* BPM / テンポ表示 */}
      <View style={styles.bpmRow}>
        <Text style={styles.bpmText}>
          {d.track?.bpm != null && d.track.bpm > 0 ? `${d.track.bpm} BPM` : "BPM --"}
        </Text>
        {effBpm != null ? (
          <Text style={styles.effBpmText}>→ {effBpm.toFixed(1)}</Text>
        ) : null}
        <View style={styles.bpmSpacer} />
        <Pressable
          onPress={cycleTempoRange}
          accessibilityRole="button"
          accessibilityLabel="テンポレンジを切替"
          style={({ pressed }) => [styles.rangeBtn, pressed && styles.pressed]}
        >
          <Text style={styles.rangeBtnText}>±{(tempoRange * 100).toFixed(0)}%</Text>
        </Pressable>
        <Text style={styles.tempoText}>{formatTempoPercent(d.tempo, tempoRange)}</Text>
      </View>

      <SeekBar
        positionMs={d.positionMs}
        durationMs={d.durationMs}
        onSeek={(ms) => seek(deck, ms)}
        disabled={!hasTrack}
      />

      {/* トランスポート行 */}
      <View style={styles.transportRow}>
        <TransportButton
          label="CUE"
          onPress={() => pressCue(deck)}
          disabled={!hasTrack}
          accessibilityLabel={`デッキ${deckLabel} キュー`}
        />
        <Pressable
          onPress={() => togglePlay(deck)}
          disabled={!hasTrack}
          accessibilityRole="button"
          accessibilityLabel={`デッキ${deckLabel} 再生/一時停止`}
          style={({ pressed }) => [
            styles.playBtn,
            d.isPlaying && styles.playBtnActive,
            !hasTrack && styles.btnDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons
            name={d.isPlaying ? "pause" : "play"}
            size={26}
            color={d.isPlaying ? BRAND.accentText : PALETTE.text}
          />
        </Pressable>
        <TransportButton
          label="SYNC"
          onPress={() => sync(deck)}
          disabled={!hasTrack}
          accessibilityLabel={`デッキ${deckLabel} シンク`}
        />
        {/* ピッチベンド（ホールドで一時的にテンポを曲げる） */}
        <NudgeButton
          label="−"
          onPressIn={() => setNudge(deck, NUDGE_DOWN)}
          onPressOut={() => setNudge(deck, null)}
          disabled={!hasTrack}
          accessibilityLabel={`デッキ${deckLabel} ナッジ マイナス`}
        />
        <NudgeButton
          label="＋"
          onPressIn={() => setNudge(deck, NUDGE_UP)}
          onPressOut={() => setNudge(deck, null)}
          disabled={!hasTrack}
          accessibilityLabel={`デッキ${deckLabel} ナッジ プラス`}
        />
      </View>

      {/* テンポフェーダー（-1..1 を 0..1 にマップ、中央基準の塗り） */}
      <View style={styles.faderRow}>
        <Text style={styles.faderLabel}>TEMPO</Text>
        <FaderBar
          value={(d.tempo + 1) / 2}
          onChange={(v) => setTempo(deck, v * 2 - 1)}
          fillFrom="center"
          accessibilityLabel={`デッキ${deckLabel} テンポフェーダー`}
        />
      </View>

      {/* チャンネルフェーダー */}
      <View style={styles.faderRow}>
        <Text style={styles.faderLabel}>VOL</Text>
        <FaderBar
          value={d.volume}
          onChange={(v) => setVolume(deck, v)}
          accessibilityLabel={`デッキ${deckLabel} チャンネルフェーダー`}
        />
      </View>
    </View>
  );
}

function TransportButton({
  label,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.transportBtn,
        disabled && styles.btnDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.transportBtnText}>{label}</Text>
    </Pressable>
  );
}

function NudgeButton({
  label,
  onPressIn,
  onPressOut,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  onPressIn: () => void;
  onPressOut: () => void;
  disabled: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.nudgeBtn,
        disabled && styles.btnDisabled,
        pressed && styles.nudgeBtnActive,
      ]}
    >
      <Text style={styles.transportBtnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: PALETTE.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PALETTE.border,
    padding: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  deckBadge: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: PALETTE.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  deckBadgeText: {
    color: BRAND.accent,
    fontSize: 15,
    fontWeight: "800",
  },
  trackInfo: {
    flex: 1,
  },
  title: {
    color: PALETTE.text,
    fontSize: 14,
    fontWeight: "600",
  },
  subtitle: {
    color: PALETTE.textDim,
    fontSize: 12,
    marginTop: 1,
  },
  emptyText: {
    color: PALETTE.textFaint,
    fontSize: 13,
  },
  loadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: PALETTE.surfaceAlt,
  },
  loadBtnText: {
    color: PALETTE.text,
    fontSize: 12,
    fontWeight: "700",
  },
  bpmRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  bpmText: {
    color: PALETTE.textDim,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  effBpmText: {
    color: BRAND.accent,
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  bpmSpacer: {
    flex: 1,
  },
  rangeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: PALETTE.surfaceAlt,
  },
  rangeBtnText: {
    color: PALETTE.textDim,
    fontSize: 11,
    fontWeight: "700",
  },
  tempoText: {
    color: PALETTE.text,
    fontSize: 13,
    fontWeight: "600",
    minWidth: 52,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  transportBtn: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    backgroundColor: PALETTE.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  transportBtnText: {
    color: PALETTE.text,
    fontSize: 13,
    fontWeight: "800",
  },
  playBtn: {
    flex: 1.4,
    height: 44,
    borderRadius: 8,
    backgroundColor: PALETTE.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  playBtnActive: {
    backgroundColor: BRAND.accent,
  },
  nudgeBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: PALETTE.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  nudgeBtnActive: {
    backgroundColor: PALETTE.accentDim,
  },
  faderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  faderLabel: {
    color: PALETTE.textFaint,
    fontSize: 10,
    fontWeight: "700",
    width: 44,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.7,
  },
});
