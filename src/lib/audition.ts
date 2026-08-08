// Audition / Preview セッションのフロント側ヘルパー。
// playCount / lastPlayed / Recently Played を汚さない聴き比べ用。

import * as playbackApi from "../api/playback";
import { useStore } from "../store/useStore";
import type { Track } from "../types";

export type PreviewReturn = {
  trackId: number | null;
  positionMs: number;
};

/** Audition モード (UI 強調 + ジャンプキー) をトグル。 */
export function toggleAuditionMode(): boolean {
  const { auditionMode, setAuditionMode } = useStore.getState();
  const next = !auditionMode;
  setAuditionMode(next);
  return next;
}

/**
 * 単曲プレビューを開始する。
 * - まだ preview 中でなければ現在位置を復帰用に保存
 * - バックエンド preview モードを ON
 * - キューを触らず playTrack のみ
 */
export async function startPreview(track: Track): Promise<void> {
  if (!track.fileExists) return;
  const state = useStore.getState();
  const { playback, previewActive, enterPreview } = state;

  // 連続プレビュー時は最初の復帰先を維持する。
  if (!previewActive) {
    enterPreview({
      trackId: playback.currentTrackId,
      positionMs: playback.positionMs,
    });
  }

  await playbackApi.setPreviewMode(true);
  await playbackApi.playTrack(track.trackId);
}

/**
 * プレビューを終了する。
 * - バックエンド preview を OFF
 * - restore が true (既定) なら保存した曲・位置へ戻す
 */
export async function exitPreview(opts?: { restore?: boolean }): Promise<void> {
  const restore = opts?.restore !== false;
  const state = useStore.getState();
  const ret = state.previewReturn;

  state.exitPreviewSession();
  try {
    await playbackApi.setPreviewMode(false);
  } catch {
    // non-tauri / offline: ignore
  }

  if (!restore || ret == null) return;
  if (ret.trackId == null) {
    try {
      await playbackApi.stop();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    await playbackApi.playTrack(ret.trackId);
    if (ret.positionMs > 0) {
      // 再生開始直後の seek を少し遅らせて安定させる
      await new Promise((r) => setTimeout(r, 80));
      await playbackApi.seek(ret.positionMs);
    }
  } catch (err) {
    console.error("exitPreview restore failed:", err);
  }
}

/**
 * 通常再生を始める前に呼ぶ: preview セッションを復帰なしで閉じる。
 * (Enter / クレート再生 / キュー再生など playCount を計上すべき操作)
 */
export async function ensureNormalPlay(): Promise<void> {
  const { previewActive, exitPreviewSession } = useStore.getState();
  let backendOn = false;
  try {
    backendOn = await playbackApi.getPreviewMode();
  } catch {
    backendOn = false;
  }
  if (!previewActive && !backendOn) return;
  exitPreviewSession();
  try {
    await playbackApi.setPreviewMode(false);
  } catch {
    /* ignore */
  }
}

/** 曲長に対する比率 (0–1) へシーク。 */
export async function seekRatio(ratio: number): Promise<void> {
  const { playback } = useStore.getState();
  if (playback.currentTrackId == null || playback.durationMs <= 0) return;
  const r = Math.min(1, Math.max(0, ratio));
  await playbackApi.seek(Math.floor(r * playback.durationMs));
}

/** 相対シーク (ms)。duration でクランプ。 */
export async function seekRelative(deltaMs: number): Promise<void> {
  const { playback } = useStore.getState();
  if (playback.currentTrackId == null) return;
  const max = playback.durationMs > 0 ? playback.durationMs : Number.MAX_SAFE_INTEGER;
  const next = Math.min(max, Math.max(0, playback.positionMs + deltaMs));
  await playbackApi.seek(next);
}
