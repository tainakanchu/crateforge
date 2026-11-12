// サーバー接続情報（baseUrl + token）のストア。
// SecureStore に永続化し、起動時に hydrate して自動再接続する。
// 全データ取得は useConnection().client（接続中のみ非 null）経由で行う。

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { ApiClient, normalizeBaseUrl } from "../lib/api/client";
import {
  type ApiErrorKind,
  classifyApiError,
  describeApiError,
  isConnectivityError,
} from "../lib/api/errors";

const KEY_URL = "crateforge.baseUrl";
const KEY_TOKEN = "crateforge.token";
// 「切断（接続先を残す）」で退避した接続先。接続中の KEY_URL/KEY_TOKEN とは別に持ち、
// 次回起動時に自動再接続されないようにする（接続画面の初期値としてだけ使う）。
const KEY_LAST_URL = "crateforge.lastBaseUrl";
const KEY_LAST_TOKEN = "crateforge.lastToken";

export interface DisconnectOptions {
  /** true なら接続先 URL を lastBaseUrl として永続化して残す（自動再接続はしない）。 */
  keepUrl?: boolean;
  /** true なら（keepUrl と併せて）トークンも lastToken として残す。keepUrl が false なら無視。 */
  keepToken?: boolean;
}

/**
 * 接続状態。
 * - "error" は「接続情報はあるがデスクトップに届かない/拒否された」状態。詳細は errorKind
 *   （"network"/"timeout" ならオフライン扱い、"unauthorized" ならトークン再入力が必要）。
 */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface ConnectionState {
  baseUrl: string | null;
  token: string | null;
  status: ConnectionStatus;
  /** UI 表示用の日本語メッセージ（describeApiError 済み）。 */
  error: string | null;
  /** 直近の失敗の種別。接続中/未接続は null。 */
  errorKind: ApiErrorKind | null;
  /** 接続確立後のみ非 null。 */
  client: ApiClient | null;
  /** hydrate() が一度完了したか。ルーティング判定はこれが true になってから行う。 */
  hydrated: boolean;
  /** recheck() 実行中か（UI の「再接続中…」表示用。status は変えない）。 */
  checking: boolean;
  /** 最後に疎通確認が成功した時刻（epoch ms）。 */
  lastOkAt: number | null;

  /** 切断時・接続失敗時に残した接続先（接続画面の初期表示用）。接続成功/全破棄で null。 */
  lastBaseUrl: string | null;
  lastToken: string | null;

  /** 起動時に SecureStore から復元し、疎通確認する。失敗しても必ず hydrated=true になる。 */
  hydrate: () => Promise<void>;
  /** 入力された URL/token で疎通確認し、成功なら永続化＆接続。戻り値は成否。 */
  connect: (baseUrl: string, token: string | null) => Promise<boolean>;
  /**
   * 切断する（自動再接続しない）。既定は URL・トークンとも破棄（TV など従来どおり）。
   * keepUrl / keepToken で接続先を lastBaseUrl / lastToken に永続化して残せる（再起動後も接続画面に初期表示）。
   */
  disconnect: (opts?: DisconnectOptions) => Promise<void>;
  /**
   * 保存済みの baseUrl/token で health を叩き直し、状態を更新する（前面復帰・オフライン中の再試行用）。
   * 成功で "connected"（client を再生成）、失敗で "error"（client=null → オフライン表示）。
   * 同時呼び出しは 1 本にまとめる。接続情報が無ければ false。
   * silent=true は定期的な死活監視用で、checking を立てない（「再接続中…」を点滅させない）。
   */
  recheck: (opts?: { silent?: boolean }) => Promise<boolean>;
  /**
   * API 呼び出しの失敗を通知する（ApiClient の onError から自動で呼ばれる。UI から呼んでもよい）。
   * - 401: 即 "error"（unauthorized）にして client を外す。
   * - ネットワーク系: recheck() で health を確かめ、届かなければ "error"（network/timeout）。
   * - それ以外（404/409/5xx 等）: 個別操作の失敗なので接続状態は変えない。
   */
  reportError: (e: unknown) => void;
}

/** オフライン扱い（保存済みの接続先に届かない）か。ダウンロード済みライブラリへ切り替える判定に使う。 */
export function selectIsOffline(s: Pick<ConnectionState, "status" | "errorKind" | "baseUrl">): boolean {
  return (
    s.baseUrl != null &&
    s.status === "error" &&
    (s.errorKind === "network" || s.errorKind === "timeout" || s.errorKind === "notCrateforge")
  );
}

/** 疎通確認のタイムアウト（ms）。 */
const PROBE_TIMEOUT_MS = 6000;

/** baseUrl + token で疎通確認する。失敗は例外。 */
async function probe(baseUrl: string, token: string | null): Promise<void> {
  const client = new ApiClient({ baseUrl, token });
  // タイムアウト付きで health を叩く（LAN 不通時に固まらないように）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await client.health(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** recheck の再入防止（モジュールスコープ）。 */
let recheckInFlight: Promise<boolean> | null = null;

/** API 成功で lastOkAt を更新する最小間隔（毎リクエストで再描画しないため）。 */
const LAST_OK_THROTTLE_MS = 5000;

/**
 * SecureStore に保存済みの接続先（`${baseUrl}\n${token}`）。recheck 成功時に未保存なら保存する判定に使う。
 * hydrate で復元した値・connect 成功で保存した値を入れ、disconnect で null に戻す。
 */
let persistedKey: string | null = null;
const connKey = (baseUrl: string, token: string | null) => `${baseUrl}\n${token ?? ""}`;

/** 接続先を保存し、切断時に退避した接続先は消す（connect 成功・recheck 成功で共通）。 */
async function persistConnection(baseUrl: string, token: string | null): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEY_URL, baseUrl),
    token ? SecureStore.setItemAsync(KEY_TOKEN, token) : SecureStore.deleteItemAsync(KEY_TOKEN),
    SecureStore.deleteItemAsync(KEY_LAST_URL),
    SecureStore.deleteItemAsync(KEY_LAST_TOKEN),
  ]);
  persistedKey = connKey(baseUrl, token);
}

export const useConnection = create<ConnectionState>((set, get) => {
  /** ストアへ失敗を通知する client を作る（probe 用の client とは別）。 */
  const makeClient = (baseUrl: string, token: string | null) =>
    new ApiClient({
      baseUrl,
      token,
      onError: (e) => get().reportError(e),
      // 「最終接続」= 最後に通信が成功した時刻（health に限らず全 API の成功で更新）。
      onSuccess: () => {
        const cur = get();
        if (cur.baseUrl !== baseUrl || cur.token !== token) return;
        const now = Date.now();
        if (cur.lastOkAt == null || now - cur.lastOkAt >= LAST_OK_THROTTLE_MS) set({ lastOkAt: now });
      },
    });

  const failState = (e: unknown) => ({
    status: "error" as const,
    error: describeApiError(e),
    errorKind: classifyApiError(e),
    client: null,
  });

  return {
    baseUrl: null,
    token: null,
    status: "idle",
    error: null,
    errorKind: null,
    client: null,
    hydrated: false,
    checking: false,
    lastOkAt: null,
    lastBaseUrl: null,
    lastToken: null,

    hydrate: async () => {
      try {
        const [baseUrl, token] = await Promise.all([
          SecureStore.getItemAsync(KEY_URL),
          SecureStore.getItemAsync(KEY_TOKEN),
        ]);
        if (!baseUrl) {
          const [lastBaseUrl, lastToken] = await Promise.all([
            SecureStore.getItemAsync(KEY_LAST_URL),
            SecureStore.getItemAsync(KEY_LAST_TOKEN),
          ]);
          set({
            status: "idle",
            hydrated: true,
            lastBaseUrl: lastBaseUrl ?? null,
            lastToken: lastBaseUrl ? (lastToken ?? null) : null,
          });
          return;
        }
        set({ baseUrl, token: token ?? null, status: "connecting", error: null, errorKind: null });
        persistedKey = connKey(baseUrl, token ?? null);
        try {
          await probe(baseUrl, token ?? null);
          set({
            client: makeClient(baseUrl, token ?? null),
            status: "connected",
            error: null,
            errorKind: null,
            lastOkAt: Date.now(),
            hydrated: true,
          });
        } catch (e) {
          // 復元はしたが疎通失敗（サーバー停止/IP 変動など）。情報は保持し再接続を促す。
          set({ ...failState(e), hydrated: true });
        }
      } catch (e) {
        // SecureStore 自体の失敗（web 等）でも起動を止めない。
        console.warn("[connection] hydrate failed:", e);
        set({ status: "idle", hydrated: true });
      } finally {
        if (!get().hydrated) set({ hydrated: true });
      }
    },

    connect: async (rawUrl, token) => {
      const baseUrl = normalizeBaseUrl(rawUrl);
      if (baseUrl === "") {
        set({ status: "error", error: "URL を入力してください", errorKind: null });
        return false;
      }
      set({ status: "connecting", error: null, errorKind: null, baseUrl, token });
      try {
        await probe(baseUrl, token);
        await persistConnection(baseUrl, token);
        set({
          lastBaseUrl: null,
          lastToken: null,
          client: makeClient(baseUrl, token),
          status: "connected",
          error: null,
          errorKind: null,
          lastOkAt: Date.now(),
        });
        return true;
      } catch (e) {
        // 失敗しても入力した接続先は退避して残す（再起動後も接続画面に入力済みで出す。round-3 N3）。
        // 自動再接続の対象（KEY_URL）にはしない。接続が成功したら persistConnection が消す。
        set({ ...failState(e), lastBaseUrl: baseUrl, lastToken: token });
        try {
          await Promise.all([
            SecureStore.setItemAsync(KEY_LAST_URL, baseUrl),
            token
              ? SecureStore.setItemAsync(KEY_LAST_TOKEN, token)
              : SecureStore.deleteItemAsync(KEY_LAST_TOKEN),
          ]);
        } catch (persistError) {
          console.warn("[connection] remember failed target failed:", persistError);
        }
        return false;
      }
    },

    disconnect: async (opts) => {
      const { baseUrl, token } = get();
      const keepUrl = !!opts?.keepUrl && !!baseUrl;
      const keepToken = keepUrl && !!opts?.keepToken && !!token;
      await Promise.all([
        SecureStore.deleteItemAsync(KEY_URL),
        SecureStore.deleteItemAsync(KEY_TOKEN),
        keepUrl
          ? SecureStore.setItemAsync(KEY_LAST_URL, baseUrl as string)
          : SecureStore.deleteItemAsync(KEY_LAST_URL),
        keepToken
          ? SecureStore.setItemAsync(KEY_LAST_TOKEN, token as string)
          : SecureStore.deleteItemAsync(KEY_LAST_TOKEN),
      ]);
      persistedKey = null;
      set({
        baseUrl: null,
        token: null,
        lastBaseUrl: keepUrl ? baseUrl : null,
        lastToken: keepToken ? token : null,
        client: null,
        status: "idle",
        error: null,
        errorKind: null,
        checking: false,
        lastOkAt: null,
      });
    },

    recheck: (opts) => {
      if (recheckInFlight) return recheckInFlight;
      const { baseUrl, token } = get();
      if (!baseUrl) return Promise.resolve(false);
      const silent = !!opts?.silent;
      const run = async (): Promise<boolean> => {
        if (!silent) set({ checking: true });
        try {
          await probe(baseUrl, token);
          // 確認中に切断/別ホストへ接続し直された場合は結果を捨てる。
          const cur = get();
          if (cur.baseUrl !== baseUrl || cur.token !== token) return false;
          // 接続画面での connect が失敗（デスクトップ停止中など）→ オフライン再試行で復帰した場合、
          // 接続先がまだ保存されていない。ここで保存しないと再起動で接続先が空になる（round-2 M5）。
          if (persistedKey !== connKey(baseUrl, token)) {
            try {
              await persistConnection(baseUrl, token);
            } catch (e) {
              console.warn("[connection] persist on recheck failed:", e);
            }
            if (get().baseUrl !== baseUrl || get().token !== token) return false;
          }
          // 既に接続済みなら client を作り直さない（全画面の再取得を避ける）。
          set({
            client: get().client ?? makeClient(baseUrl, token),
            lastBaseUrl: null,
            lastToken: null,
            status: "connected",
            error: null,
            errorKind: null,
            lastOkAt: Date.now(),
          });
          return true;
        } catch (e) {
          const cur = get();
          if (cur.baseUrl !== baseUrl || cur.token !== token) return false;
          set(failState(e));
          return false;
        } finally {
          if (!silent) set({ checking: false });
        }
      };
      recheckInFlight = run().finally(() => {
        recheckInFlight = null;
      });
      return recheckInFlight;
    },

    reportError: (e) => {
      const kind = classifyApiError(e);
      if (kind === "unauthorized") {
        // トークン失効/取り消し。以後の呼び出しも全部 401 になるので即座に外す。
        if (get().status !== "error" || get().errorKind !== "unauthorized") set(failState(e));
        return;
      }
      if (isConnectivityError(e) && get().status === "connected") {
        // 単発の失敗で即オフラインにしない。health で確かめてから遷移する。
        void get().recheck();
      }
    },
  };
});
