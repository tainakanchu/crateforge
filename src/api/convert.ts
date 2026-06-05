import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ConvertRequest, ConvertProgress } from "../types";

/// 選択トラックを別フォーマットへ変換する（バックグラウンド実行、進捗はイベント）。
export async function convertTracks(request: ConvertRequest): Promise<void> {
  return invoke("convert_tracks", { request });
}

export async function onConvertProgress(
  handler: (p: ConvertProgress) => void,
): Promise<UnlistenFn> {
  return listen<ConvertProgress>("convert-progress", (e) => handler(e.payload));
}
