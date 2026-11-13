import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Track } from "../types";

// OS の「このアプリで開く」/ 既定のプレーヤー (ファイル関連付け) で渡された音声ファイル。
// ライブラリにある曲は通常の曲として、無い曲は DB に追加せず「一時再生曲」として再生する。

/// ライブラリ外の一時再生曲の ID か。バックエンドは一時再生曲に負の ID を割り当てる
/// (DB の trackId は常に 1 以上)。判定は必ずこの関数を通す。
export function isTransientTrackId(trackId: number | null | undefined): boolean {
  return trackId != null && trackId < 0;
}

export interface OpenedFilesResult {
  /// 置き換えたキュー (開いた順)。
  trackIds: number[];
  playingTrackId: number | null;
  libraryCount: number;
  transientCount: number;
}

/// 起動前 / フロント準備前に届いていたファイルを取り出す (マウント時に 1 回)。
/// これ以降に届いたファイルは onOpenFiles で受け取る。
export async function takePendingOpenFiles(): Promise<string[]> {
  return invoke("take_pending_open_files");
}

/// 開いたファイルで再生キューを置き換え (開いた順)、先頭から再生する。
export async function playOpenedFiles(paths: string[]): Promise<OpenedFilesResult> {
  return invoke("play_opened_files", { paths });
}

/// 起動中に「このアプリで開く」でファイルが渡されたときに発火する。
export async function onOpenFiles(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("open-files", (e) => cb(e.payload));
}

/// 一時再生曲をライブラリへ取り込む。再生は止まらず、キュー / 再生中の曲は
/// 取り込んだ曲 (正の trackId) に付け替わる。取り込んだ曲を返す。
export async function importTransientTrack(trackId: number): Promise<Track> {
  return invoke("import_transient_track", { trackId });
}
