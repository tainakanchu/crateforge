// オフライン UI 用の小さな表示ヘルパ。
// バイト数を人間が読める単位（B/KB/MB/GB）に整形する。Downloads 画面と設定行で共有する。

/** バイト数を B/KB/MB/GB に整形（小数 1 桁、KB 以上）。null/負値は "0 B"。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // B はそのまま整数、それ以上は小数 1 桁。
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** ダウンロード音質ラベル（UI 表示用）。 */
export const QUALITY_LABEL: Record<string, string> = {
  original: "原本",
  aac256: "AAC 256k",
  aac192: "AAC 192k",
  aac128: "AAC 128k",
};
