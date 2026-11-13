import type { ConvertFormat, ReplaceItemResult } from "../types";

// 可逆 (または無圧縮) のコーデック表示名。src-tauri/src/converter/in_place.rs と揃える。
const LOSSLESS_CODECS = new Set(["FLAC", "ALAC", "WAV", "AIFF", "WavPack", "APE"]);
const LOSSY_FORMATS = new Set<ConvertFormat>(["mp3", "aac", "opus"]);

export function isLosslessCodec(codec: string): boolean {
  return LOSSLESS_CODECS.has(codec);
}

/**
 * 非可逆 → 非可逆 (世代劣化) になる曲の数。コーデック不明の曲は数えない
 * (実際の判定は変換時に実ファイルで行い、結果の警告で分かる)。
 */
export function countLossyToLossy(
  codecs: (string | null | undefined)[],
  format: ConvertFormat,
): number {
  if (!LOSSY_FORMATS.has(format)) return 0;
  return codecs.filter((c) => !!c && !isLosslessCodec(c)).length;
}

// 結果の理由コード → 短い表示名。
const REASON_LABELS: Record<string, string> = {
  already_target_format: "変換不要",
  not_found: "曲なし",
  no_file: "ファイルなし",
  probe_failed: "読み取り失敗",
  encode_failed: "変換失敗",
  tag_copy_failed: "タグ失敗",
  decode_failed: "検証失敗",
  duration_mismatch: "長さ不一致",
  replace_failed: "置き換え失敗",
};

const WARNING_LABELS: Record<string, string> = {
  lossy_to_lossy: "非可逆→非可逆",
  trash_failed: "ゴミ箱不可→_replaced",
};

export function reasonLabel(code: string | null): string {
  if (!code) return "";
  return REASON_LABELS[code] ?? code;
}

export function warningLabel(code: string): string {
  return WARNING_LABELS[code] ?? code;
}

/** 一覧に出す (成功以外、または警告付きの) 結果。 */
export function notableResults(results: ReplaceItemResult[]): ReplaceItemResult[] {
  return results.filter(
    (r) => r.status !== "ok" || r.warnings.some((w) => w !== "lossy_to_lossy"),
  );
}
