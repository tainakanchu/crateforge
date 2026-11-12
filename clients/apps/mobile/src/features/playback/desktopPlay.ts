// 「デスクトップで再生」: 曲リストを PC 側の再生キューに載せて指定位置から再生する。
// remoteSetQueue(ids, start, { play: true })（新しいホスト）。古いホストは play を無視してキュー置換のみ。

import { type Track, describeApiError, useConnection } from "@crateforge/core";

import { showActionSheet } from "@/components/ActionSheet";
import { showToast } from "@/components/Toast";

export async function playOnDesktop(tracks: Track[], startIndex = 0): Promise<boolean> {
  const client = useConnection.getState().client;
  if (!client) {
    showToast("デスクトップに接続されていません", "error");
    return false;
  }
  if (tracks.length === 0) return false;
  try {
    await client.remoteSetQueue(
      tracks.map((t) => t.trackId),
      startIndex,
      { play: true },
    );
    showToast("デスクトップで再生を開始しました");
    return true;
  } catch (e) {
    // 生の本文（{"error":...}）を出さず、日本語の理由にする（round-3 N7）。
    showToast(`デスクトップで再生できませんでした: ${describeApiError(e)}`, "error");
    return false;
  }
}

/**
 * 1 曲を「デスクトップで再生」（round-2 M11）。
 * デスクトップ側のキューを黙って置き換えないよう、キューに曲があるときは確認を出す。
 * ホストにキューへの挿入 API が無いため「次に再生（挿入）」は提供できない
 * （set-queue で擬似的に挿入するとシャッフル中は再シャッフルされ順序が保てない）。
 * - デスクトップのキューが空 / 取得できない（古いホスト）: そのまま再生。
 * - キューに曲がある: 「今すぐ再生（キューを置き換え）」/ キャンセル を選ばせる。
 */
export async function playTrackOnDesktop(track: Track): Promise<void> {
  const client = useConnection.getState().client;
  if (!client) {
    showToast("デスクトップに接続されていません", "error");
    return;
  }
  let queued = 0;
  let alreadyCurrent = false;
  try {
    const q = await client.remoteQueue();
    queued = q.trackIds.length;
    alreadyCurrent =
      q.currentIndex != null && q.trackIds[q.currentIndex] === track.trackId && queued === 1;
  } catch {
    // 古いホスト等でキューが取れない場合は従来どおり（確認なしで置き換え）。
    queued = 0;
  }
  if (queued === 0 || alreadyCurrent) {
    await playOnDesktop([track], 0);
    return;
  }
  showActionSheet({
    title: "デスクトップで再生",
    subtitle: `デスクトップの再生キュー（${queued}曲）はこの曲だけに置き換わります`,
    actions: [
      {
        label: "今すぐ再生（キューを置き換え）",
        onPress: () => void playOnDesktop([track], 0),
      },
    ],
  });
}
