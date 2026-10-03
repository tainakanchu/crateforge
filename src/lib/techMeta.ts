// 技術メタデータ (#171) — bitrate / sample rate / size / codec の表示と判定。
// Rust 側 metadata::tech::codec_label が返すコーデック表示名を前提にする。

import type { Track } from "../types";

/** ロスレス (またはリニア PCM) のコーデック表示名。ビットレートの高低は問題にしない。 */
export const LOSSLESS_CODECS: ReadonlySet<string> = new Set([
  "FLAC",
  "ALAC",
  "WAV",
  "AIFF",
  "APE",
  "WavPack",
]);

/** Gig Readiness の「低ビットレート」判定のしきい値 (kbps 未満で警告)。 */
export const LOW_BITRATE_KBPS = 256;

export function isLossless(t: Pick<Track, "codec">): boolean {
  return t.codec != null && LOSSLESS_CODECS.has(t.codec);
}

/**
 * ロッシー曲でビットレートがしきい値未満か。
 * ロスレスは対象外、ビットレート未取得 (null) は判定不能なので false。
 */
export function isLowBitrate(
  t: Pick<Track, "codec" | "bitrateKbps">,
  thresholdKbps: number = LOW_BITRATE_KBPS,
): boolean {
  if (isLossless(t)) return false;
  if (t.bitrateKbps == null || t.bitrateKbps <= 0) return false;
  return t.bitrateKbps < thresholdKbps;
}

/** 44100 → "44.1 kHz"、48000 → "48 kHz"。null は空文字。 */
export function formatSampleRate(hz: number | null | undefined): string {
  if (hz == null || hz <= 0) return "";
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** 1 → "Mono"、2 → "Stereo"、それ以外 → "N ch"。 */
export function formatChannels(ch: number | null | undefined): string {
  if (ch == null || ch <= 0) return "";
  if (ch === 1) return "Mono";
  if (ch === 2) return "Stereo";
  return `${ch} ch`;
}

/** バイト数を "8.4 MB" のような表記にする (1024 進)。 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
