// iTunes 互換 XML の自動エクスポート (「ライブラリの自動保存」) をいつ走らせるかを決める。
// タイマーと時計は注入できる純ロジック (tests/desktop/autoExportScheduler.test.ts で固定する)。
//
// 仕様 (docs/ui-spec.md):
//   - ライブラリに未書き出しの変更 (dirty) があるときだけ書き出す。
//   - アイドル: 最後の変更・最後の操作 (キー / ポインタ / ホイール) から IDLE_MS 何もなければ書き出す。
//   - フォーカス喪失: ウィンドウが非アクティブ / 非表示になったら、dirty ならすぐ書き出す。
//   - 上限: 操作が続いても、最初の未書き出し変更から MAX_WAIT_MS 以内には書き出す。
//   - 失敗時は dirty に戻し、アイドルタイマーで再試行する。
//   - 書き出し中に変更が来たら、終わったあとにアイドルタイマーを張り直す (即時には走らせない)。

export const IDLE_MS = 60_000;
export const MAX_WAIT_MS = 10 * 60_000;

type TimerId = unknown;

export interface AutoExportSchedulerOptions {
  /** 実際の書き出し。失敗時は throw する。 */
  run: () => Promise<void>;
  /** false のとき (自動保存オフ・出力先未設定) は書き出さず dirty のまま保つ。 */
  canRun?: () => boolean;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => TimerId;
  clearTimeout?: (id: TimerId) => void;
  idleMs?: number;
  maxWaitMs?: number;
}

export interface AutoExportScheduler {
  /** ライブラリに変更があった。 */
  markDirty(): void;
  /** ユーザー操作 (キー / ポインタ / ホイール)。clean のときは何もしない。 */
  noteInput(): void;
  /** ウィンドウがフォーカスを失った / 非表示になった。dirty ならすぐ書き出す。 */
  noteFocusLost(): void;
  /** 外部 (アプリ終了時など) で書き出しが済んだ。 */
  markClean(): void;
  isDirty(): boolean;
  isInFlight(): boolean;
  /** dirty なら今すぐ書き出す (書き出し中なら何もしない)。 */
  flush(): Promise<void>;
  dispose(): void;
}

export function createAutoExportScheduler(opts: AutoExportSchedulerOptions): AutoExportScheduler {
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearT =
    opts.clearTimeout ??
    ((id: TimerId) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>));
  const canRun = opts.canRun ?? (() => true);
  const idleMs = opts.idleMs ?? IDLE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;

  let dirty = false;
  let dirtySince: number | null = null;
  let lastActivity = 0;
  let inFlight = false;
  let disposed = false;
  let idleTimer: TimerId | null = null;
  let maxTimer: TimerId | null = null;

  const clearTimers = () => {
    if (idleTimer !== null) clearT(idleTimer);
    if (maxTimer !== null) clearT(maxTimer);
    idleTimer = null;
    maxTimer = null;
  };

  // アイドルタイマー: 発火時点で最後の活動から idleMs 経っていなければ残りぶん張り直す。
  // 入力のたびにタイマーを作り直さずに済む (noteInput は時刻を記録するだけ)。
  const armIdle = (delay: number) => {
    if (disposed) return;
    if (idleTimer !== null) clearT(idleTimer);
    idleTimer = setT(() => {
      idleTimer = null;
      if (!dirty) return;
      const quiet = now() - lastActivity;
      if (quiet < idleMs) armIdle(idleMs - quiet);
      else void flush();
    }, Math.max(0, delay));
  };

  const armMaxWait = () => {
    if (disposed || maxTimer !== null || dirtySince === null) return;
    const delay = Math.max(0, dirtySince + maxWaitMs - now());
    maxTimer = setT(() => {
      maxTimer = null;
      if (dirty) void flush();
    }, delay);
  };

  const flush = async (): Promise<void> => {
    if (disposed || !dirty || inFlight) return;
    if (!canRun()) return;
    inFlight = true;
    dirty = false; // optimistic クリア (書き出し中の変更は再び dirty になる)
    dirtySince = null;
    clearTimers();
    try {
      await opts.run();
    } catch {
      // 失敗: dirty に戻し、アイドルタイマーで再試行する。上限は今から数え直す。
      if (!dirty) {
        dirty = true;
        dirtySince = now();
      }
      lastActivity = now();
    } finally {
      inFlight = false;
      if (dirty && !disposed) {
        if (dirtySince === null) dirtySince = now();
        armIdle(Math.max(0, lastActivity + idleMs - now()));
        armMaxWait();
      }
    }
  };

  return {
    markDirty() {
      if (disposed) return;
      const t = now();
      lastActivity = t;
      if (!dirty) {
        dirty = true;
        if (dirtySince === null) dirtySince = t;
      }
      if (inFlight) return; // 書き出し後に張り直す
      if (idleTimer === null) armIdle(idleMs);
      armMaxWait();
    },
    noteInput() {
      if (!dirty) return;
      lastActivity = now();
    },
    noteFocusLost() {
      if (dirty) void flush();
    },
    markClean() {
      dirty = false;
      dirtySince = null;
      clearTimers();
    },
    isDirty: () => dirty,
    isInFlight: () => inFlight,
    flush,
    dispose() {
      disposed = true;
      clearTimers();
    },
  };
}
