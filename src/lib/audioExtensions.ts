/**
 * 対応オーディオ拡張子リスト。
 * ツールバーのファイル選択ダイアログとドラッグ&ドロップ取り込みで共有する。
 * 大文字小文字の正規化は呼び出し側で行う。
 */
export const AUDIO_EXTENSIONS = [
  "flac",
  "mp3",
  "m4a",
  "wav",
  "aac",
  "ogg",
  "opus",
  "aiff",
  "wma",
] as const;
