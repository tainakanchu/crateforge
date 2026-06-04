import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TrackAnalysis, AnalysisStatus, AnalysisProgress } from "../types";

/// 指定トラックをバックグラウンド解析キューへ投入する。force で再解析を強制。
export async function analyzeTracks(trackIds: number[], force = false): Promise<void> {
  return invoke("analyze_tracks", { trackIds, force });
}

export async function getAnalysis(trackId: number): Promise<TrackAnalysis | null> {
  return invoke("get_analysis", { trackId });
}

export async function getAnalysisStatus(): Promise<AnalysisStatus> {
  return invoke("get_analysis_status");
}

export async function getAllAnalyses(): Promise<TrackAnalysis[]> {
  return invoke("get_all_analyses");
}

export async function onAnalysisProgress(
  handler: (p: AnalysisProgress) => void,
): Promise<UnlistenFn> {
  return listen<AnalysisProgress>("analysis-progress", (e) => handler(e.payload));
}
