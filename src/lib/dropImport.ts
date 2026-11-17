import { AUDIO_EXTENSIONS } from "./audioExtensions.ts";

const EXT_SET = new Set<string>(AUDIO_EXTENSIONS);

function extensionOf(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // 先頭ドット (.hidden) は拡張子ではない。
  if (dot <= 0) return null;
  return base.slice(dot + 1);
}

/** 拡張子が `.zip` (大文字小文字は無視) のパスか。実在の確認は Rust 側で行う。 */
export function isZipPath(path: string): boolean {
  return extensionOf(path)?.toLowerCase() === "zip";
}

/**
 * ドラッグ中のオーバーレイを出すべきパスか (ヒント判定)。
 *
 * drag-drop イベントの `paths` は文字列だけで、実際にファイルかフォルダかは
 * ここでは分からない。そこで
 *   - 対応オーディオ拡張子 / `.zip` → 表示 (zip は展開して取り込む)
 *   - 「拡張子らしいもの」が付いていない → フォルダとみなして表示
 *     (`Album [2001.05]` のようなフォルダ名を弾かないよう、英数 5 文字以内の
 *      サフィックスだけを拡張子とみなす)
 * とする。あくまで表示判定で、実際の取り込み可否は Rust 側が実パスを見て決める。
 */
export function looksImportable(path: string): boolean {
  const ext = extensionOf(path);
  if (ext === null) return true;
  const lower = ext.toLowerCase();
  if (EXT_SET.has(lower) || lower === "zip") return true;
  return !/^[A-Za-z0-9]{1,5}$/.test(ext);
}

/** パスの末尾 (ファイル名) を返す。トースト表示用。 */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
