import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string | null;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  return invoke("check_for_update");
}

export async function updateSmtc(
  title: string,
  artist: string,
  album: string,
  isPlaying: boolean,
  positionMs: number,
  durationMs: number,
): Promise<void> {
  return invoke("update_smtc", {
    title,
    artist,
    album,
    isPlaying,
    positionMs,
    durationMs,
  });
}

export type SmtcButton = "play" | "pause" | "toggle" | "next" | "prev" | "stop";

export async function onSmtcButton(
  handler: (kind: SmtcButton) => void,
): Promise<UnlistenFn> {
  return listen<string>("smtc-button", (e) => handler(e.payload as SmtcButton));
}
