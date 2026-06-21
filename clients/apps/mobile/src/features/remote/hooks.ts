// Remote スライスのデータ取得/操作フック群。
// デスクトップ側の再生状態をポーリングし、リモートコマンドを送る。
// 取得は client-gated（接続中のみ enabled）。コマンド成功時に remote 系クエリを invalidate する。

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { type PlaybackState, type RemoteQueue, type Track, useConnection } from "@crateforge/core";

/** remote 系クエリの共通キープレフィックス。 */
const REMOTE_KEY = ["remote"] as const;

/** デスクトップの再生状態を 1 秒間隔でポーリングする。 */
export function useRemoteState() {
  const client = useConnection((s) => s.client);
  return useQuery<PlaybackState>({
    queryKey: ["remote", "state"],
    enabled: !!client,
    refetchInterval: 1000,
    queryFn: ({ signal }) => client!.remoteState(signal),
  });
}

/** デスクトップのキュー（trackId 配列 + 現在位置）を 2 秒間隔でポーリングする。 */
export function useRemoteQueue() {
  const client = useConnection((s) => s.client);
  return useQuery<RemoteQueue>({
    queryKey: ["remote", "queue"],
    enabled: !!client,
    refetchInterval: 2000,
    queryFn: ({ signal }) => client!.remoteQueue(signal),
  });
}

/** キューの trackId 群を Track[] に解決する依存クエリ（trackIds をキーに含める）。 */
export function useRemoteQueueTracks() {
  const client = useConnection((s) => s.client);
  const queue = useRemoteQueue();
  const trackIds = queue.data?.trackIds ?? [];
  return useQuery<Track[]>({
    queryKey: ["remote", "queue-tracks", trackIds],
    enabled: !!client && trackIds.length > 0,
    queryFn: () => client!.tracksByIds(trackIds),
  });
}

export interface RemoteCommands {
  play: (trackId: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  setQueue: (trackIds: number[], startIndex?: number) => Promise<void>;
  /** 操作後の手動リフレッシュ用。 */
  refresh: () => Promise<void>;
}

/** リモート操作のコマンド群。成功時に remote 系クエリを invalidate して即時反映する。 */
export function useRemoteCommands(): RemoteCommands {
  const client = useConnection((s) => s.client);
  const qc = useQueryClient();

  const invalidate = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: REMOTE_KEY });
  }, [qc]);

  return useMemo<RemoteCommands>(() => {
    const run = async (action: () => Promise<unknown>): Promise<void> => {
      if (!client) return;
      await action();
      await invalidate();
    };
    return {
      play: (trackId) => run(() => client!.remotePlay(trackId)),
      pause: () => run(() => client!.remotePause()),
      resume: () => run(() => client!.remoteResume()),
      stop: () => run(() => client!.remoteStop()),
      next: () => run(() => client!.remoteNext()),
      prev: () => run(() => client!.remotePrev()),
      seek: (positionMs) => run(() => client!.remoteSeek(positionMs)),
      setQueue: (trackIds, startIndex) => run(() => client!.remoteSetQueue(trackIds, startIndex)),
      refresh: invalidate,
    };
  }, [client, invalidate]);
}
