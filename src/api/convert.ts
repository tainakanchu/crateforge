import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ConvertProgress,
  ConvertReplaceProgress,
  ConvertReplaceRequest,
  ConvertRequest,
} from "../types";

/// 選択トラックを別フォーマットへ変換する（バックグラウンド実行、進捗はイベント）。
export async function convertTracks(request: ConvertRequest): Promise<void> {
  return invoke("convert_tracks", { request });
}

export async function onConvertProgress(
  handler: (p: ConvertProgress) => void,
): Promise<UnlistenFn> {
  return listen<ConvertProgress>("convert-progress", (e) => handler(e.payload));
}

/// 選択トラックを変換し、同じ曲のまま新しいファイルへ置き換える (バックグラウンド)。ジョブ ID を返す。
export async function convertReplaceTracks(request: ConvertReplaceRequest): Promise<string> {
  return invoke("convert_replace_tracks", { request });
}

export async function onConvertReplaceProgress(
  handler: (p: ConvertReplaceProgress) => void,
): Promise<UnlistenFn> {
  return listen<ConvertReplaceProgress>("convert-replace-progress", (e) => handler(e.payload));
}
