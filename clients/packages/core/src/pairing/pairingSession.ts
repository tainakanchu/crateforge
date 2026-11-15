// コード承認ペアリングの状態機械（mobile / TV 共通、UI 非依存）。
//   pairStart（コード取得）→ intervalMs ごとに pairPoll → approved / expired / エラーで終了。
// 画面は onEvent を受けて表示を切り替え、approved のときに useConnection.connect を呼ぶ。
// mDNS の探索そのもの（ネイティブモジュール）はアプリ側。ここには発見結果の重複排除だけ置く。

import { ApiError } from "../lib/api/client";
import { DESKTOP_API_SETTINGS_PATH } from "../lib/api/errors";
import type { PairPollResponse, PairStartResponse } from "../lib/types";

/** ペアリング承認の確認間隔（ms）。 */
export const PAIRING_POLL_INTERVAL_MS = 2000;

/** 承認確認 1 回のタイムアウト（ms）。接続の疎通確認（PROBE_TIMEOUT_MS）と同じ長さ。 */
export const PAIRING_POLL_TIMEOUT_MS = 6000;

/**
 * コードの有効期間（ms）。デスクトップ側（src-tauri/src/pairing.rs の EXPIRY = 600 秒）と同じ。
 * これを過ぎたら、応答が無くても（タイムアウトが続いていても）期限切れとして終了する。
 */
export const PAIRING_CODE_LIFETIME_MS = 10 * 60 * 1000;

/** デスクトップ側でコードを入力する場所（案内文用）。 */
export const DESKTOP_PAIR_APPROVE_PATH = `${DESKTOP_API_SETTINGS_PATH} → 端末を承認`;

/** コードの期限切れ（poll が expired を返した）ときの文言。 */
export const PAIRING_EXPIRED_MESSAGE = "コードが期限切れになりました。もう一度お試しください。";

/** ペアリングに必要な API だけを切り出した形（ApiClient が満たす）。 */
export interface PairingClient {
  pairStart(deviceName?: string, platform?: string): Promise<PairStartResponse>;
  pairPoll(session: string, signal?: AbortSignal): Promise<PairPollResponse>;
}

/**
 * ペアリングの進行イベント。
 * - code: pairStart 成功。コードを表示して承認待ちに入った（この後ポーリングが始まる）。
 * - approved: 承認された。token で接続する（終了）。
 * - expired: コードが期限切れ（終了）。
 * - error: 失敗（終了）。stage は pairStart（"start"）か承認確認（"poll"）か。
 *   文言は画面側で describeApiError(error, { action }) にする。
 */
export type PairingEvent =
  | { type: "code"; code: string }
  | { type: "approved"; token: string }
  | { type: "expired" }
  | { type: "error"; stage: "start" | "poll"; error: unknown };

export interface PairingSessionOptions {
  client: PairingClient;
  deviceName: string;
  platform: string;
  /** 承認確認の間隔。既定は PAIRING_POLL_INTERVAL_MS。 */
  intervalMs?: number;
  /** 承認確認 1 回のタイムアウト。既定は PAIRING_POLL_TIMEOUT_MS。 */
  pollTimeoutMs?: number;
  /** コードの有効期間。既定は PAIRING_CODE_LIFETIME_MS。 */
  lifetimeMs?: number;
  onEvent: (event: PairingEvent) => void;
}

export interface PairingSession {
  /** ペアリングを中断する。以後 onEvent は呼ばれず、ポーリングも止まる。何度呼んでもよい。 */
  cancel(): void;
}

/**
 * ペアリングを開始する。approved / expired / error のいずれかを 1 回だけ通知して終了する。
 * - cancel 後や終了後に返ってきた応答は捨てる（pairStart 待ちの間に cancel しても
 *   ポーリングは始まらない）。
 * - 前回の確認がまだ返っていない間は次の確認を投げない（応答の追い越しで二重に
 *   approved を通知しないため）。
 * - 確認が pollTimeoutMs 返らなければ中断して「まだ承認待ち」と扱い、次の間隔でまた確認する
 *   （1 回固まっただけでポーリングが止まったままにならないように）。
 * - コードを受け取ってから lifetimeMs 経ったら expired で終了する（タイムアウトが続いて
 *   いつまでも承認待ちのままにならないように）。デスクトップは期限切れのセッションに
 *   404 を返すので、確認が 404 で失敗したときも error ではなく expired として扱う。
 */
export function startPairingSession(options: PairingSessionOptions): PairingSession {
  const { client, deviceName, platform, onEvent } = options;
  const intervalMs = options.intervalMs ?? PAIRING_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? PAIRING_POLL_TIMEOUT_MS;
  const lifetimeMs = options.lifetimeMs ?? PAIRING_CODE_LIFETIME_MS;

  let done = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  /** 進行中の確認を止める（タイムアウトの解除 + リクエストの中断）。 */
  let abortPoll: (() => void) | null = null;

  const stop = () => {
    done = true;
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    if (lifetimeTimer != null) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = null;
    }
    abortPoll?.();
  };

  /** タイムアウト付きの確認。時間内に返らなければ null（= まだ承認待ち扱い）。 */
  const pollOnce = (session: string): Promise<PairPollResponse | null> =>
    new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const giveUp = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        controller.abort();
        resolve(null);
      };
      const timeout = setTimeout(giveUp, pollTimeoutMs);
      abortPoll = giveUp;
      client.pairPoll(session, controller.signal).then(
        (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(res);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        },
      );
    });

  const finish = (event: PairingEvent) => {
    if (done) return;
    stop();
    onEvent(event);
  };

  const poll = async (session: string) => {
    if (done || polling) return;
    polling = true;
    try {
      const res = await pollOnce(session);
      if (res == null) return; // タイムアウト: 次の間隔でまた確認する。
      if (res.status === "approved" && res.token != null) {
        finish({ type: "approved", token: res.token });
      } else if (res.status === "expired") {
        finish({ type: "expired" });
      }
      // pending（および token 無しの approved）は次の確認を待つ。
    } catch (error) {
      // 期限切れ（またはデスクトップ再起動で消えた）セッションは 404 で返る。
      if (error instanceof ApiError && error.status === 404) {
        finish({ type: "expired" });
      } else {
        finish({ type: "error", stage: "poll", error });
      }
    } finally {
      polling = false;
      abortPoll = null;
    }
  };

  void (async () => {
    let started: PairStartResponse;
    try {
      started = await client.pairStart(deviceName, platform);
    } catch (error) {
      finish({ type: "error", stage: "start", error });
      return;
    }
    if (done) return;
    onEvent({ type: "code", code: started.code });
    // onEvent の中で cancel された場合はポーリングを始めない。
    if (done) return;
    timer = setInterval(() => {
      void poll(started.session);
    }, intervalMs);
    lifetimeTimer = setTimeout(() => finish({ type: "expired" }), lifetimeMs);
  })();

  return { cancel: stop };
}

/** mDNS で見つかったサービスの同一性キー（"host:port"。そのまま接続先アドレスにもなる）。 */
export function discoveredKey(svc: { host: string; port: number }): string {
  return `${svc.host}:${svc.port}`;
}

/**
 * 発見済み一覧に svc を足す。同じ host:port が既にあれば prev をそのまま（同じ参照で）返す
 * ので、setState の更新関数にそのまま渡せる。
 */
export function dedupeDiscovered<T extends { host: string; port: number }>(prev: T[], svc: T): T[] {
  const key = discoveredKey(svc);
  if (prev.some((s) => discoveredKey(s) === key)) return prev;
  return [...prev, svc];
}
