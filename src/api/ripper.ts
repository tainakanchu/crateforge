import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DiscToc,
  ReleaseCandidate,
  RipProgress,
  RipRequest,
} from "../types";

export async function detectDisc(device?: string): Promise<DiscToc> {
  return invoke("detect_disc", { device: device ?? null });
}

/** ディスクが入っているかの軽量チェック (TOC は読まない / Windows)。失敗時は false。 */
export async function discPresent(device: string): Promise<boolean> {
  return invoke("disc_present", { device });
}

/** 接続されている CD ドライブ一覧 (Windows: ["E:"] など)。取得失敗時は空配列。 */
export async function listCdDrives(): Promise<string[]> {
  return invoke("list_cd_drives");
}

export async function lookupReleaseByDiscId(
  musicbrainzId: string,
): Promise<ReleaseCandidate[]> {
  return invoke("lookup_release_by_disc_id", { musicbrainzId });
}

export async function lookupReleaseByToc(
  trackCount: number,
  leadout: number,
  offsets: number[],
): Promise<ReleaseCandidate[]> {
  return invoke("lookup_release_by_toc", { trackCount, leadout, offsets });
}

export async function ripCd(request: RipRequest): Promise<void> {
  return invoke("rip_cd", { request });
}

export async function onRipProgress(
  handler: (p: RipProgress) => void,
): Promise<UnlistenFn> {
  return listen<RipProgress>("rip-progress", (e) => handler(e.payload));
}
