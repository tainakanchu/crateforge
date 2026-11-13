// Android で再生できない「原本」ダウンロードの判定（design D7 の救済導線）。
// Android の再生エンジン（ExoPlayer）は AIFF / CAF を扱えないため、original 品質で保存した
// これらの形式はローカルでは鳴らない（接続中はネイティブが AAC ストリームへ切り替えるが、
// オフラインでは UNSUPPORTED_FORMAT になる）。ダウンロード画面から AAC で取り直せるようにする。

import type { DownloadEntry, DownloadQuality } from "@crateforge/core";

/** Android で再生できない原本の拡張子（小文字）。 */
const ANDROID_UNSUPPORTED_EXTS = new Set(["aiff", "aif", "aifc", "caf"]);

/** 再ダウンロード時の音質。 */
export const AAC_REDOWNLOAD_QUALITY: DownloadQuality = "aac192";

/** 保存ファイルの拡張子（小文字。判定できなければ null）。 */
function localExt(localUri: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(localUri.split(/[?#]/)[0] ?? "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * Android で再生できない原本なら、その拡張子（大文字表記）を返す。対象外は null。
 * platform は呼び出し側の Platform.OS（iOS は AIFF/CAF を再生できるので対象外）。
 */
export function androidUnsupportedOriginal(
  entry: Pick<DownloadEntry, "quality" | "localUri">,
  platform: string,
): string | null {
  if (platform !== "android" || entry.quality !== "original") return null;
  const ext = localExt(entry.localUri);
  return ext != null && ANDROID_UNSUPPORTED_EXTS.has(ext) ? ext.toUpperCase() : null;
}
