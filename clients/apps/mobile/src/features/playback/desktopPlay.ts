// 「デスクトップで再生」: 曲リストを PC 側の再生キューに載せて指定位置から再生する。
// remoteSetQueue(ids, start, { play: true })（新しいホスト）。古いホストは play を無視してキュー置換のみ。

import { type Track, useConnection } from "@crateforge/core";

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
    showToast(`デスクトップで再生できませんでした${e instanceof Error ? `（${e.message}）` : ""}`, "error");
    return false;
  }
}
