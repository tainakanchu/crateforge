// Remote スライスのデータ取得/操作フック群。
// デスクトップ側の再生状態をポーリングし、リモートコマンドを送る。
// 取得は client-gated（接続中のみ enabled）。コマンド成功時に remote 系クエリを invalidate する。
// ポーリングはこのタブが表示中かつアプリが前面のときだけ走らせる（電池・LAN 負荷の削減）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AppState, type AppStateStatus } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";

import {
  ApiError,
  type PlaybackState,
  type RemoteQueue,
  type RepeatMode,
  type Track,
  describeApiError,
  isAuthError,
  useConnection,
} from "@crateforge/core";

import { showToast } from "@/components/Toast";

/** remote 系クエリの共通キープレフィックス。 */
const REMOTE_KEY = ["remote"] as const;

/** AppState が前面（active）か。未知（テスト環境など）は前面扱い。 */
function isActiveState(s: AppStateStatus | null | undefined): boolean {
  return s !== "background" && s !== "inactive";
}

/**
 * ポーリングしてよいか（画面がフォーカス中 かつ アプリが前面）。
 * フォーカスは expo-router の useFocusEffect で追う。タブ画面はマウントされたまま
 * 裏に回るので、blur で false にしてポーリングを止める。
 */
export function usePollingActive(): boolean {
  const [focused, setFocused] = useState(true);
  const [appActive, setAppActive] = useState(() => isActiveState(AppState.currentState));

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => setAppActive(isActiveState(next)));
    return () => sub.remove();
  }, []);

  return focused && appActive;
}

/** デスクトップの再生状態を 1 秒間隔でポーリングする（active=false の間は止める）。 */
export function useRemoteState(active = true) {
  const client = useConnection((s) => s.client);
  return useQuery<PlaybackState>({
    queryKey: ["remote", "state"],
    enabled: !!client && active,
    refetchInterval: active ? 1000 : false,
    queryFn: ({ signal }) => client!.remoteState(signal),
  });
}

/** デスクトップのキュー（trackId 配列 + 現在位置）を 2 秒間隔でポーリングする（active=false の間は止める）。 */
export function useRemoteQueue(active = true) {
  const client = useConnection((s) => s.client);
  return useQuery<RemoteQueue>({
    queryKey: ["remote", "queue"],
    enabled: !!client && active,
    refetchInterval: active ? 2000 : false,
    queryFn: ({ signal }) => client!.remoteQueue(signal),
  });
}

/** キューの trackId 群を Track[] に解決する依存クエリ（trackIds をキーに含める）。 */
export function useRemoteQueueTracks(active = true) {
  const client = useConnection((s) => s.client);
  const queue = useRemoteQueue(active);
  const trackIds = queue.data?.trackIds ?? [];
  return useQuery<Track[]>({
    queryKey: ["remote", "queue-tracks", trackIds],
    enabled: !!client && trackIds.length > 0,
    queryFn: () => client!.tracksByIds(trackIds),
  });
}

export interface RemoteCommands {
  play: (trackId: number) => Promise<boolean>;
  pause: () => Promise<boolean>;
  resume: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  next: () => Promise<boolean>;
  prev: () => Promise<boolean>;
  seek: (positionMs: number) => Promise<boolean>;
  setQueue: (trackIds: number[], startIndex?: number, opts?: { play?: boolean }) => Promise<boolean>;
  /**
   * 現在のキュー（useRemoteQueue().data.trackIds の並び）の index 番目を再生する。
   * 古いホスト（play-at 未対応 = 404/405）では fallbackTrackIds でキューを置き換えて再生する。
   */
  playAt: (index: number, fallbackTrackIds?: number[]) => Promise<boolean>;
  setVolume: (volume: number) => Promise<boolean>;
  setShuffle: (on: boolean) => Promise<boolean>;
  setRepeat: (mode: RepeatMode) => Promise<boolean>;
  /** 操作後の手動リフレッシュ用。 */
  refresh: () => Promise<void>;
}

/** 操作名（失敗トーストの「<操作>に失敗しました」に使う）。 */
const ACTION_LABEL = {
  play: "再生",
  pause: "一時停止",
  resume: "再生",
  stop: "停止",
  next: "次の曲",
  prev: "前の曲",
  seek: "シーク",
  setQueue: "キューの設定",
  playAt: "再生",
  volume: "音量の変更",
  shuffle: "シャッフルの切替",
  repeat: "リピートの切替",
} as const;

/**
 * リモート操作のコマンド群。成功時に remote 系クエリを invalidate して即時反映する。
 * 失敗はトーストで通知し（戻り値 false）、401 は再接続画面への誘導を出す。
 */
export function useRemoteCommands(): RemoteCommands {
  const client = useConnection((s) => s.client);
  const qc = useQueryClient();
  const router = useRouter();

  const invalidate = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: REMOTE_KEY });
  }, [qc]);

  return useMemo<RemoteCommands>(() => {
    const notifyFailure = (e: unknown, action: string) => {
      const message = describeApiError(e, { action });
      if (isAuthError(e)) {
        Alert.alert("再接続が必要です", message, [
          { text: "閉じる", style: "cancel" },
          { text: "再接続", onPress: () => router.push("/connect") },
        ]);
        return;
      }
      showToast(message, "error");
    };

    const run = async (
      action: keyof typeof ACTION_LABEL,
      fn: () => Promise<unknown>,
    ): Promise<boolean> => {
      if (!client) {
        showToast("デスクトップに接続されていません", "error");
        return false;
      }
      try {
        await fn();
      } catch (e) {
        notifyFailure(e, ACTION_LABEL[action]);
        // 状態がずれている可能性があるので取り直す。
        await invalidate().catch(() => undefined);
        return false;
      }
      await invalidate();
      return true;
    };

    return {
      play: (trackId) => run("play", () => client!.remotePlay(trackId)),
      pause: () => run("pause", () => client!.remotePause()),
      resume: () => run("resume", () => client!.remoteResume()),
      stop: () => run("stop", () => client!.remoteStop()),
      next: () => run("next", () => client!.remoteNext()),
      prev: () => run("prev", () => client!.remotePrev()),
      seek: (positionMs) => run("seek", () => client!.remoteSeek(positionMs)),
      setQueue: (trackIds, startIndex, opts) =>
        run("setQueue", () =>
          opts?.play
            ? client!.remoteSetQueue(trackIds, startIndex, { play: true })
            : client!.remoteSetQueue(trackIds, startIndex),
        ),
      playAt: (index, fallbackTrackIds) =>
        run("playAt", async () => {
          try {
            await client!.remotePlayAt(index);
          } catch (e) {
            // play-at 未対応の古いホスト。キュー置き換え + play で代替する。
            if (
              e instanceof ApiError &&
              (e.status === 404 || e.status === 405) &&
              fallbackTrackIds &&
              fallbackTrackIds.length > 0
            ) {
              await client!.remoteSetQueue(fallbackTrackIds, index, { play: true });
              return;
            }
            throw e;
          }
        }),
      setVolume: (volume) => run("volume", () => client!.remoteVolume(volume)),
      setShuffle: (on) => run("shuffle", () => client!.remoteShuffle(on)),
      setRepeat: (mode) => run("repeat", () => client!.remoteRepeat(mode)),
      refresh: invalidate,
    };
  }, [client, invalidate, router]);
}
