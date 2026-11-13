export function defaultDevice(): string {
  if (navigator.userAgent.includes("Win")) return "D:";
  if (navigator.userAgent.includes("Mac")) return "disk1";
  return "/dev/cdrom";
}

/**
 * RipDialog を開いたときに選ぶドライブ。
 * 優先順: 検出ダイアログの検出元 > 保存済み (ripDevice) > 検出した先頭 > 既定値。
 * `drives` がまだ取得できていないとき (null) は検出結果を待たずに決められる分だけ返す。
 */
export function initialRipDevice(opts: {
  detected: string | null;
  saved: string | null;
  drives: string[] | null;
  fallback: string;
}): string {
  if (opts.detected) return opts.detected;
  if (opts.saved) return opts.saved;
  return opts.drives?.[0] ?? opts.fallback;
}
