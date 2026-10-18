// Android ネイティブ再生バックエンド（Media3 / Android Auto）。
// usePlayer のアクション関数だけを差し替え、キュー・再生状態の正本をネイティブへ移す。
// hook の同一性・selector・current()/upNext()/upNextEntries はそのままなので UI 側の変更は最小で済む。
//
// 不変条件（docs/android-auto/design.md §5.2）:
// - JS 側の自動送り（_onFinished / _onError / _onProgress / _onPlayingChange）は完全に無効化する。
//   曲の遷移はネイティブ（ExoPlayer）だけが行い、二重に進まない。
// - 楽観更新しない。ストアの再生状態はネイティブから届いた state だけで更新する（ネイティブが常に勝つ）。
// - コマンドは呼び出し順に即 dispatch する（直列化はネイティブ main queue）。ready 前は内部キューに溜める。
// - コマンド失敗時は resync（connect + getQueue）して lastError を立てる。
// - hydrate はネイティブのキューを空で上書きしない（SecureStore の shuffle/repeat を移行に渡すだけ）。
//
// core はネイティブモジュールを import しない。構造型の NativePlaybackBridge を受け取り、
// mobile（Android のみ）が明示的に install する。TV / iOS はこのファイルを経由しない。

import * as SecureStore from "expo-secure-store";

import type { Track } from "../lib/types";
import {
  NoopAudioEngine,
  PLAYER_SETTINGS_KEYS,
  usePlayer,
  type AudioEngine,
  type PlayerState,
  type RepeatMode,
} from "../store/player";
import type {
  NativePlaybackState,
  NativeProgressEvent,
  NativeQueueSnapshot,
  NativeSubscription,
} from "./nativeTypes";

/** ネイティブ再生への橋渡し。モジュールに依存しない構造型（mobile がアダプタを実装する）。 */
export interface NativePlaybackBridge {
  connect(): Promise<NativePlaybackState>;
  getQueue(): Promise<NativeQueueSnapshot>;
  addStateListener(l: (s: NativePlaybackState) => void): NativeSubscription;
  addProgressListener(l: (p: NativeProgressEvent) => void): NativeSubscription;
  setQueue(tracks: Track[], startIndex: number): Promise<void>;
  playAt(i: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(ms: number): Promise<void>;
  skipNext(): Promise<void>;
  skipPrevious(): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  setRepeat(m: RepeatMode): Promise<void>;
  setRate(r: number): Promise<void>;
  enqueue(tracks: Track[], mode: "end" | "next"): Promise<void>;
  removeQueueAt(i: number): Promise<void>;
  moveQueueItem(f: number, t: number): Promise<void>;
  moveUpNext(f: number, t: number): Promise<void>;
  clearQueue(): Promise<void>;
  setSleepTimer(ms: number | null): Promise<void>;
  setStopAtTrackEnd(v: boolean): Promise<void>;
  clearError(): Promise<void>;
  migrateLegacySettings(s: { shuffle: boolean | null; repeat: RepeatMode | null }): Promise<boolean>;
}

export interface NativePlaybackInstallation {
  /** 初回同期（connect → getQueue → ストア反映）の完了。失敗しても reject しない（lastError で通知）。 */
  ready: Promise<void>;
  /**
   * ネイティブの現状態（connect + getQueue）を取り直す。アプリの前面復帰時など、
   * イベントを取りこぼした可能性があるときに呼ぶ。失敗はログのみ（lastError は立てない）。
   */
  resync(): Promise<void>;
  /** 元の JS アクションへ戻す（テスト用）。購読も解除する。 */
  uninstall(): void;
}

/** コマンド失敗時にユーザーへ出す文言（失敗内容はネイティブ state の再同期で正す）。 */
export const NATIVE_COMMAND_FAILED_MESSAGE = "操作に失敗しました";
/** 初回接続に失敗したときの文言。 */
export const NATIVE_CONNECT_FAILED_MESSAGE = "再生サービスに接続できませんでした";

/** 差し替えるアクション（元の実装は uninstall で戻す）。 */
const SWAPPED_KEYS = [
  "setEngine",
  "setQueue",
  "playAt",
  "toggle",
  "play",
  "pause",
  "next",
  "prev",
  "seek",
  "setRepeat",
  "setShuffle",
  "removeQueueAt",
  "moveQueueItem",
  "moveUpNext",
  "setRate",
  "setSleepTimer",
  "setStopAtTrackEnd",
  "enqueue",
  "enqueueNext",
  "clear",
  "clearError",
  "hydrate",
  "_onProgress",
  "_onFinished",
  "_onPlayingChange",
  "_onError",
] as const satisfies readonly (keyof PlayerState)[];

type SwappedKey = (typeof SWAPPED_KEYS)[number];
type SwappedActions = Pick<PlayerState, SwappedKey>;

/** 失敗時の扱い。resync = 再同期 + lastError、log = ログのみ（裏方の処理用）。 */
type FailurePolicy = "resync" | "log";

/** ログ用にエラーの分類だけを取り出す（引数やトークン等の値は出さない）。 */
function describeError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return typeof code === "string" ? `${code}: ${message}` : message;
}

function isRepeatMode(v: unknown): v is RepeatMode {
  return v === "off" || v === "all" || v === "one";
}

/** order が 0..n-1 の順列か。 */
function isPermutation(order: readonly number[], n: number): boolean {
  if (order.length !== n) return false;
  const seen = new Uint8Array(n);
  for (const v of order) {
    if (!Number.isInteger(v) || v < 0 || v >= n || seen[v]) return false;
    seen[v] = 1;
  }
  return true;
}

/** 1 回の install に対応する実体。uninstall 後は全コールバックが no-op になる。 */
class NativePlaybackSession {
  readonly ready: Promise<void>;

  private disposed = false;
  private isReady = false;
  /** ready 前に呼ばれたコマンド（呼び出し順）。 */
  private pending: (() => void)[] = [];
  private subscriptions: NativeSubscription[] = [];

  /** ストアの queue/order が対応している queueVersion。 */
  private appliedQueueVersion = -1;
  /** 直近に反映した state が示す queueVersion（これ未満の getQueue 応答は古いので捨てる）。 */
  private latestQueueVersion = -1;
  /** 既に扱ったネイティブエラーの atEpochMs（同じエラーを二重に通知しない）。 */
  private lastSeenErrorAt: number | null = null;

  /** getQueue の取得ループ（多重起動しない）。 */
  private queueTask: Promise<void> | null = null;
  private queueRefetch = false;
  /** 実行中の getQueue を投げた時点の latestQueueVersion（同じ版の state で重ねて取り直さない）。 */
  private queueFetchTarget = -1;
  /** resync の実行（多重起動しない）。 */
  private resyncTask: Promise<void> | null = null;
  private resyncAgain = false;

  private readonly original: SwappedActions;
  private readonly originalEngine: AudioEngine;

  constructor(private readonly bridge: NativePlaybackBridge) {
    const st = usePlayer.getState();
    this.original = Object.fromEntries(SWAPPED_KEYS.map((k) => [k, st[k]])) as SwappedActions;
    this.originalEngine = st.engine;
    // ready より前に購読する（接続中に届いた変化も取りこぼさない）。
    // 購読に失敗したらストアには触れずに例外を返す（呼び出し側が JS 経路へ退避できる）。
    try {
      this.subscriptions.push(bridge.addStateListener((s) => this.onState(s)));
      this.subscriptions.push(bridge.addProgressListener((p) => this.onProgress(p)));
    } catch (e) {
      this.disposed = true;
      for (const sub of this.subscriptions) sub.remove();
      this.subscriptions = [];
      throw e;
    }
    // JS エンジンが既に鳴っていても二重に音を出さない（解放は所有者に任せる）。
    try {
      st.engine.pause();
    } catch {
      // Noop / 解放済みエンジンは無視。
    }
    usePlayer.setState({ ...this.actions(), engine: new NoopAudioEngine() });
    this.ready = this.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    for (const sub of this.subscriptions) {
      try {
        sub.remove();
      } catch {
        // 解除失敗は無視。
      }
    }
    this.subscriptions = [];
    usePlayer.setState({ ...this.original, engine: this.originalEngine });
  }

  // --- 初回同期 / 再同期 -------------------------------------------------

  private async start(): Promise<void> {
    try {
      const state = await this.bridge.connect();
      if (this.disposed) return;
      // 起動前に出ていたエラーは古いので通知しない（既読扱いにするだけ）。
      this.applyState(state, { surfaceError: false });
      await this.refreshQueue();
    } catch (e) {
      if (this.disposed) return;
      console.warn("[playback/native] connect failed:", describeError(e));
      usePlayer.setState({ lastError: { message: NATIVE_CONNECT_FAILED_MESSAGE, at: Date.now() } });
    } finally {
      if (!this.disposed) {
        this.isReady = true;
        const queued = this.pending;
        this.pending = [];
        for (const run of queued) run();
      }
    }
  }

  /** 外部（前面復帰など）からの再同期。ready 前は初回同期の完了を待つだけ。 */
  requestResync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.isReady) return this.ready;
    return this.resync();
  }

  /** connect() + getQueue() でストアをネイティブの現状態に合わせ直す。 */
  private resync(): Promise<void> {
    if (this.resyncTask) {
      this.resyncAgain = true;
      return this.resyncTask;
    }
    const run = async () => {
      do {
        this.resyncAgain = false;
        try {
          const state = await this.bridge.connect();
          if (this.disposed) return;
          this.applyState(state, { surfaceError: true });
          await this.refreshQueue();
        } catch (e) {
          console.warn("[playback/native] resync failed:", describeError(e));
        }
      } while (this.resyncAgain && !this.disposed);
    };
    this.resyncTask = run().finally(() => {
      this.resyncTask = null;
    });
    return this.resyncTask;
  }

  /** getQueue を取り直してストアへ反映する。実行中なら終わり次第もう 1 回取る。 */
  private refreshQueue(): Promise<void> {
    if (this.queueTask) {
      this.queueRefetch = true;
      return this.queueTask;
    }
    const run = async () => {
      do {
        this.queueRefetch = false;
        this.queueFetchTarget = this.latestQueueVersion;
        try {
          const snapshot = await this.bridge.getQueue();
          if (this.disposed) return;
          this.applySnapshot(snapshot);
        } catch (e) {
          // 次の state 変化か resync で取り直す。
          console.warn("[playback/native] getQueue failed:", describeError(e));
          return;
        }
      } while (this.queueRefetch && !this.disposed);
    };
    this.queueTask = run().finally(() => {
      this.queueTask = null;
    });
    return this.queueTask;
  }

  // --- ネイティブ → ストア ----------------------------------------------

  private onState(state: NativePlaybackState): void {
    if (this.disposed) return;
    const stale = this.applyState(state, { surfaceError: true });
    // 同じ版を取得中なら重ねない（巨大キューの全量取得を繰り返さない）。
    if (stale && !(this.queueTask && state.queueVersion === this.queueFetchTarget)) {
      void this.refreshQueue();
    }
  }

  private onProgress(p: NativeProgressEvent): void {
    if (this.disposed) return;
    usePlayer.setState({
      positionMs: Math.max(0, p.positionMs),
      durationMs: Math.max(0, p.durationMs),
      isPlaying: p.isPlaying,
    });
  }

  /**
   * state のスカラー値をストアへ反映する。戻り値はキューの取り直しが必要か。
   * イベントも connect() の応答もネイティブ main looper 上で発行順に届くため、届いた順に
   * そのまま反映する（revision での破棄はしない。Service 再生成で値が巻き戻っても追従できる）。
   * キューだけは別取得（getQueue）なので queueVersion で新旧を判定する。
   */
  private applyState(state: NativePlaybackState, opts: { surfaceError: boolean }): boolean {
    this.latestQueueVersion = state.queueVersion;

    const updates: Partial<PlayerState> = {
      isPlaying: state.isPlaying,
      positionMs: Math.max(0, state.positionMs),
      durationMs: Math.max(0, state.durationMs),
      shuffle: state.shuffle,
      repeat: isRepeatMode(state.repeat) ? state.repeat : "off",
      playbackRate: Number.isFinite(state.rate) && state.rate > 0 ? state.rate : 1,
      sleepTimerMs: state.sleepTimerMs,
      stopAtTrackEnd: state.stopAtTrackEnd,
    };
    // index/orderPos は手元の queue と同じ版のときだけ反映する（版違いの間は getQueue の結果で更新）。
    const queueStale = state.queueVersion !== this.appliedQueueVersion;
    if (!queueStale) {
      updates.index = state.index;
      updates.orderPos = state.orderPos;
    }
    const err = state.lastError;
    if (err && err.atEpochMs !== this.lastSeenErrorAt) {
      this.lastSeenErrorAt = err.atEpochMs;
      if (opts.surfaceError) {
        updates.lastError = { message: err.message, at: err.atEpochMs, code: err.code };
      }
    }
    usePlayer.setState(updates);
    return queueStale;
  }

  /** getQueue の結果をストアへ反映する。直近 state より古い版は捨てる。 */
  private applySnapshot(snapshot: NativeQueueSnapshot): void {
    if (snapshot.queueVersion < this.latestQueueVersion) return;
    this.appliedQueueVersion = snapshot.queueVersion;
    this.latestQueueVersion = snapshot.queueVersion;

    const queue = snapshot.items.map((item) => item.track as unknown as Track);
    const n = queue.length;
    if (n === 0) {
      usePlayer.setState({ queue: [], order: [], orderPos: -1, index: -1 });
      return;
    }
    // ネイティブの順列は正しい前提だが、壊れた値で UI を落とさないよう最低限検証する。
    const index = snapshot.index >= 0 && snapshot.index < n ? snapshot.index : -1;
    if (isPermutation(snapshot.order, n)) {
      const orderPos =
        snapshot.orderPos >= 0 && snapshot.orderPos < n && snapshot.order[snapshot.orderPos] === index
          ? snapshot.orderPos
          : snapshot.order.indexOf(index);
      usePlayer.setState({ queue, order: [...snapshot.order], orderPos, index });
      return;
    }
    console.warn("[playback/native] invalid order in queue snapshot; using natural order");
    usePlayer.setState({
      queue,
      order: Array.from({ length: n }, (_, i) => i),
      orderPos: index,
      index,
    });
  }

  // --- ストア → ネイティブ ----------------------------------------------

  /**
   * コマンドを送る。ready 前は溜めて、ready 後に呼び出し順で送る。
   * 戻り値はコマンドの完了（失敗時も resolve。失敗は policy に従って処理済み）。
   */
  private command(name: string, run: () => Promise<unknown>, policy: FailurePolicy = "resync"): Promise<void> {
    return new Promise<void>((resolve) => {
      const exec = () => {
        if (this.disposed) {
          resolve();
          return;
        }
        let p: Promise<unknown>;
        try {
          p = run();
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(
          () => resolve(),
          (e: unknown) => {
            this.onCommandFailed(name, e, policy);
            resolve();
          },
        );
      };
      if (this.isReady) exec();
      else this.pending.push(exec);
    });
  }

  private onCommandFailed(name: string, e: unknown, policy: FailurePolicy): void {
    console.warn(`[playback/native] ${name} failed:`, describeError(e));
    if (this.disposed || policy === "log") return;
    usePlayer.setState({ lastError: { message: NATIVE_COMMAND_FAILED_MESSAGE, at: Date.now() } });
    void this.resync();
  }

  /** 差し替え後のアクション群。 */
  private actions(): SwappedActions {
    const b = this.bridge;
    const get = usePlayer.getState;
    const cmd = (name: string, run: () => Promise<unknown>, policy?: FailurePolicy) => {
      void this.command(name, run, policy);
    };
    return {
      // ネイティブモードでは JS エンジンを使わない（expo-audio の Player/MediaSession を作らせない）。
      setEngine: () => {},

      setQueue: (tracks, startIndex = 0) => {
        if (tracks.length === 0) {
          cmd("clearQueue", () => b.clearQueue());
          return;
        }
        const start = Math.max(0, Math.min(startIndex, tracks.length - 1));
        cmd("setQueue", () => b.setQueue(tracks, start));
      },
      playAt: (index) => {
        if (index < 0 || index >= get().queue.length) return;
        cmd("playAt", () => b.playAt(index));
      },
      toggle: () => {
        if (get().isPlaying) get().pause();
        else get().play();
      },
      play: () => cmd("play", () => b.play()),
      pause: () => cmd("pause", () => b.pause()),
      // auto 引数は無視（自動送りはネイティブのみ。ここに来るのは常に手動操作）。
      next: () => cmd("skipNext", () => b.skipNext()),
      // 3 秒規則はネイティブ側（JS と同じ規則）。
      prev: () => cmd("skipPrevious", () => b.skipPrevious()),
      seek: (positionMs) => cmd("seekTo", () => b.seekTo(Math.max(0, positionMs))),

      setRepeat: (mode) =>
        cmd("setRepeat", async () => {
          await b.setRepeat(mode);
          // フォールバック（expo-audio 経路）用の値も揃えておく。正本はネイティブ。
          void SecureStore.setItemAsync(PLAYER_SETTINGS_KEYS.repeat, mode).catch(() => {});
        }),
      setShuffle: (shuffle) =>
        cmd("setShuffle", async () => {
          await b.setShuffle(shuffle);
          void SecureStore.setItemAsync(PLAYER_SETTINGS_KEYS.shuffle, shuffle ? "true" : "false").catch(
            () => {},
          );
        }),

      // 範囲外などの無効操作は JS 実装と同じく黙って無視する（ネイティブへ送ってエラー表示しない）。
      removeQueueAt: (index) => {
        if (index < 0 || index >= get().queue.length) return;
        cmd("removeQueueAt", () => b.removeQueueAt(index));
      },
      moveQueueItem: (from, to) => {
        const n = get().queue.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
        cmd("moveQueueItem", () => b.moveQueueItem(from, to));
      },
      moveUpNext: (from, to) => {
        const { order, orderPos } = get();
        const n = order.length;
        if (from < 0 || to < 0 || from >= n || to >= n || from === to) return;
        if (from < orderPos + 1 || to < orderPos + 1) return;
        cmd("moveUpNext", () => b.moveUpNext(from, to));
      },

      setRate: (rate) => {
        const clamped = Math.max(0.5, Math.min(2.0, rate));
        cmd("setRate", () => b.setRate(clamped));
      },
      // スリープタイマー / 曲終わり停止はネイティブが実行主体（画面のマウント有無に依存しない）。
      setSleepTimer: (ms) => {
        const value = ms != null && ms > 0 ? ms : null;
        cmd("setSleepTimer", () => b.setSleepTimer(value));
      },
      setStopAtTrackEnd: (v) => cmd("setStopAtTrackEnd", () => b.setStopAtTrackEnd(v)),

      enqueue: (track) => cmd("enqueue", () => b.enqueue([track], "end")),
      enqueueNext: (track) => cmd("enqueueNext", () => b.enqueue([track], "next")),
      clear: () => cmd("clearQueue", () => b.clearQueue()),

      clearError: () => {
        // lastError は UI 通知用の JS 側の値。消費はその場で反映し、ネイティブ側も消す。
        // ここが失敗しても再通知のループにしないため log のみ。
        usePlayer.setState({ lastError: null });
        cmd("clearError", () => b.clearError(), "log");
      },

      hydrate: async () => {
        // キューは触らない（ネイティブが復元済み）。旧 SecureStore の shuffle/repeat を
        // ネイティブ未初期化時の移行値として渡すだけ。
        let shuffle: boolean | null = null;
        let repeat: RepeatMode | null = null;
        try {
          const [shuffleRaw, repeatRaw] = await Promise.all([
            SecureStore.getItemAsync(PLAYER_SETTINGS_KEYS.shuffle),
            SecureStore.getItemAsync(PLAYER_SETTINGS_KEYS.repeat),
          ]);
          if (shuffleRaw === "true" || shuffleRaw === "false") shuffle = shuffleRaw === "true";
          if (isRepeatMode(repeatRaw)) repeat = repeatRaw;
        } catch {
          // 読み出し失敗は「値なし」として移行に渡す。
        }
        await this.command("migrateLegacySettings", () => b.migrateLegacySettings({ shuffle, repeat }), "log");
      },

      // JS 側の自動送り・エンジンイベントは完全に無効化（二重自動送り防止）。
      _onProgress: () => {},
      _onFinished: () => {},
      _onPlayingChange: () => {},
      _onError: () => {},
    };
  }
}

/** 現在有効な install（無ければ JS エンジン経路）。 */
let active: NativePlaybackSession | null = null;

/**
 * usePlayer をネイティブ再生バックエンドへ切り替える。
 * 既に install 済みなら前のものを外してから入れ直す（二重購読しない）。
 */
export function installNativePlaybackBackend(bridge: NativePlaybackBridge): NativePlaybackInstallation {
  active?.dispose();
  active = null;
  const session = new NativePlaybackSession(bridge);
  active = session;
  return {
    ready: session.ready,
    resync: () => session.requestResync(),
    uninstall: () => {
      session.dispose();
      if (active === session) active = null;
    },
  };
}

/** ネイティブ再生バックエンドが有効か（Android ネイティブモードのみ true）。 */
export function isNativePlaybackActive(): boolean {
  return active != null;
}
