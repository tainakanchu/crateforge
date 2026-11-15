// core/src/pairing/pairingSession.ts のテスト（core に jest 設定が無いためアプリのテストツリーに置く）。
// pairStart → 2 秒ごとの pairPoll → approved / expired / error の状態機械を偽タイマーで確認する。
// ApiClient の pairStart / pairPoll 自体（URL・ヘッダ）は pairClient.test.ts で見ている。

import {
  ApiError,
  type PairingClient,
  type PairingEvent,
  type PairPollResponse,
  dedupeDiscovered,
  discoveredKey,
  startPairingSession,
} from "@crateforge/core";

/** 溜まっている Promise の継続を流す。 */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** 外から解決できる Promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClient(polls: Array<PairPollResponse | Error>) {
  let i = 0;
  const client = {
    pairStart: jest.fn(async (_deviceName?: string, _platform?: string) => ({
      session: "sess-1",
      code: "123456",
    })),
    pairPoll: jest.fn(async (_session: string, _signal?: AbortSignal): Promise<PairPollResponse> => {
      const next = polls[Math.min(i, polls.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return client satisfies PairingClient;
}

function start(client: PairingClient, intervalMs?: number) {
  const events: PairingEvent[] = [];
  const session = startPairingSession({
    client,
    deviceName: "Living TV",
    platform: "android-tv",
    intervalMs,
    onEvent: (e) => events.push(e),
  });
  return { events, session };
}

describe("startPairingSession", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("pairStart に端末名とプラットフォームを渡し、コードを通知する", async () => {
    const client = makeClient([{ status: "pending" }]);
    const { events } = start(client);
    await flush();

    expect(client.pairStart).toHaveBeenCalledWith("Living TV", "android-tv");
    expect(events).toEqual([{ type: "code", code: "123456" }]);
    // コード取得直後には確認しない（最初の確認は 2 秒後）。
    expect(client.pairPoll).not.toHaveBeenCalled();
  });

  it("既定では 2 秒ごとに pairPoll し、pending の間は続ける", async () => {
    const client = makeClient([{ status: "pending" }]);
    const { events } = start(client);
    await flush();

    jest.advanceTimersByTime(1999);
    await flush();
    expect(client.pairPoll).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(1);
    expect(client.pairPoll).toHaveBeenCalledWith("sess-1", expect.anything());

    jest.advanceTimersByTime(2000);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: "code", code: "123456" }]);
  });

  it("approved で token を通知して止まる", async () => {
    const client = makeClient([{ status: "pending" }, { status: "approved", token: "tok-abc" }]);
    const { events } = start(client);
    await flush();

    jest.advanceTimersByTime(2000);
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();
    expect(events).toEqual([
      { type: "code", code: "123456" },
      { type: "approved", token: "tok-abc" },
    ]);

    jest.advanceTimersByTime(10_000);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("token 無しの approved は承認扱いにせず確認を続ける", async () => {
    const client = makeClient([{ status: "approved" }, { status: "approved", token: "tok" }]);
    const { events } = start(client);
    await flush();

    jest.advanceTimersByTime(2000);
    await flush();
    expect(events).toHaveLength(1);

    jest.advanceTimersByTime(2000);
    await flush();
    expect(events[1]).toEqual({ type: "approved", token: "tok" });
  });

  it("expired を通知して止まる", async () => {
    const client = makeClient([{ status: "expired" }]);
    const { events } = start(client);
    await flush();

    jest.advanceTimersByTime(2000);
    await flush();
    expect(events).toEqual([{ type: "code", code: "123456" }, { type: "expired" }]);

    jest.advanceTimersByTime(10_000);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(1);
  });

  it("期限切れのセッションへの確認が 404 で失敗したら、error ではなく expired", async () => {
    // デスクトップは期限切れのセッションに 404 + {"status":"expired"} を返し、ApiClient は 404 を投げる。
    const client = makeClient([new ApiError(404, "HTTP 404")]);
    const { events } = start(client);
    await flush();

    jest.advanceTimersByTime(2000);
    await flush();
    expect(events).toEqual([{ type: "code", code: "123456" }, { type: "expired" }]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("404 以外の失敗は従来どおり stage: poll のエラー", async () => {
    const boom = new ApiError(500, "HTTP 500");
    const client = makeClient([boom]);
    const { events } = start(client);
    await flush();

    jest.advanceTimersByTime(2000);
    await flush();
    expect(events[1]).toEqual({ type: "error", stage: "poll", error: boom });
  });

  it("コードの有効期間（10 分）を過ぎたら、応答が無くても expired で終了する", async () => {
    // すべての確認が固まる（タイムアウトが続く）最悪ケース。
    const client = makeClient([{ status: "pending" }]);
    client.pairPoll.mockImplementation(() => new Promise<PairPollResponse>(() => {}));
    const { events } = start(client);
    await flush();

    // 10 分の直前までは承認待ちのまま（確認はタイムアウトしては投げ直している）。
    for (let elapsed = 0; elapsed < 10 * 60 * 1000 - 1000; elapsed += 1000) {
      jest.advanceTimersByTime(1000);
      await flush();
    }
    expect(events).toEqual([{ type: "code", code: "123456" }]);
    expect(client.pairPoll.mock.calls.length).toBeGreaterThan(10);

    jest.advanceTimersByTime(1000);
    await flush();
    expect(events).toEqual([{ type: "code", code: "123456" }, { type: "expired" }]);

    const calls = client.pairPoll.mock.calls.length;
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(calls);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("lifetimeMs で有効期間を変えられる。pending が続いても期限で終了する", async () => {
    const client = makeClient([{ status: "pending" }]);
    const events: PairingEvent[] = [];
    startPairingSession({
      client,
      deviceName: "TV",
      platform: "android-tv",
      lifetimeMs: 5000,
      onEvent: (e) => events.push(e),
    });
    await flush();
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(1000);
      await flush();
    }
    expect(events).toEqual([{ type: "code", code: "123456" }, { type: "expired" }]);
  });

  it("pairStart の失敗は stage: start のエラーで、ポーリングしない", async () => {
    const client = makeClient([{ status: "pending" }]);
    const boom = new Error("network down");
    client.pairStart.mockRejectedValueOnce(boom);
    const { events } = start(client);
    await flush();

    expect(events).toEqual([{ type: "error", stage: "start", error: boom }]);
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(client.pairPoll).not.toHaveBeenCalled();
  });

  it("pairPoll の失敗は stage: poll のエラーで止まる", async () => {
    const boom = new Error("poll failed");
    const client = makeClient([boom]);
    const { events } = start(client);
    await flush();

    jest.advanceTimersByTime(2000);
    await flush();
    expect(events).toEqual([
      { type: "code", code: "123456" },
      { type: "error", stage: "poll", error: boom },
    ]);

    jest.advanceTimersByTime(10_000);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(1);
  });

  it("intervalMs で確認間隔を変えられる", async () => {
    const client = makeClient([{ status: "pending" }]);
    start(client, 500);
    await flush();

    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(500);
      await flush();
    }
    expect(client.pairPoll).toHaveBeenCalledTimes(3);
  });

  it("cancel 後はポーリングもイベントも止まる", async () => {
    const client = makeClient([{ status: "approved", token: "tok" }]);
    const { events, session } = start(client);
    await flush();

    session.cancel();
    session.cancel(); // 何度呼んでもよい
    jest.advanceTimersByTime(10_000);
    await flush();

    expect(client.pairPoll).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "code", code: "123456" }]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("pairStart の応答待ちの間に cancel したら、コードも通知せずポーリングも始めない", async () => {
    const client = makeClient([{ status: "pending" }]);
    const d = deferred<{ session: string; code: string }>();
    client.pairStart.mockReturnValueOnce(d.promise);
    const { events, session } = start(client);

    session.cancel();
    d.resolve({ session: "late", code: "999999" });
    await flush();
    jest.advanceTimersByTime(10_000);
    await flush();

    expect(events).toEqual([]);
    expect(client.pairPoll).not.toHaveBeenCalled();
  });

  it("確認の応答待ちの間に cancel したら、遅れて届いた approved は捨てる", async () => {
    const client = makeClient([{ status: "pending" }]);
    const d = deferred<PairPollResponse>();
    client.pairPoll.mockReturnValueOnce(d.promise);
    const { events, session } = start(client);
    await flush();

    jest.advanceTimersByTime(2000);
    await flush();
    session.cancel();
    d.resolve({ status: "approved", token: "late" });
    await flush();

    expect(events).toEqual([{ type: "code", code: "123456" }]);
  });

  it("前回の確認が返るまで（タイムアウトまで）は次の確認を投げず、approved は 1 回だけ通知する", async () => {
    const client = makeClient([{ status: "approved", token: "second" }]);
    const d = deferred<PairPollResponse>();
    client.pairPoll.mockReturnValueOnce(d.promise);
    const { events } = start(client);
    await flush();

    // 2 秒目に確認開始。4 秒目・6 秒目の間隔は、まだ返っていないので投げない。
    jest.advanceTimersByTime(6000);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(1);

    d.resolve({ status: "approved", token: "first" });
    await flush();
    jest.advanceTimersByTime(6000);
    await flush();

    expect(events).toEqual([
      { type: "code", code: "123456" },
      { type: "approved", token: "first" },
    ]);
    expect(client.pairPoll).toHaveBeenCalledTimes(1);
  });

  it("確認が固まってもタイムアウトで中断し、次の確認で承認を拾う", async () => {
    const client = makeClient([{ status: "approved", token: "tok-after-hang" }]);
    let hungSignal: AbortSignal | undefined;
    // 1 回目は永久に返らない（abort しても reject しない最悪ケース）。
    client.pairPoll.mockImplementationOnce((_session: string, signal?: AbortSignal) => {
      hungSignal = signal;
      return new Promise<PairPollResponse>(() => {});
    });
    const { events } = start(client);
    await flush();

    // 2 秒目に確認開始 → 6 秒（既定のタイムアウト）固まる。
    jest.advanceTimersByTime(2000);
    await flush();
    jest.advanceTimersByTime(5999);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(1);
    expect(hungSignal?.aborted).toBe(false);

    // タイムアウト: リクエストを中断し、エラーにはせず承認待ちのまま。
    jest.advanceTimersByTime(1);
    await flush();
    expect(hungSignal?.aborted).toBe(true);
    expect(events).toEqual([{ type: "code", code: "123456" }]);

    // 次の間隔で確認し直して approved。
    jest.advanceTimersByTime(2000);
    await flush();
    expect(client.pairPoll).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: "code", code: "123456" },
      { type: "approved", token: "tok-after-hang" },
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("タイムアウト後に遅れて届いた応答は捨てる", async () => {
    const client = makeClient([{ status: "pending" }]);
    const d = deferred<PairPollResponse>();
    client.pairPoll.mockReturnValueOnce(d.promise);
    const { events } = start(client, undefined);
    await flush();

    jest.advanceTimersByTime(2000 + 6000);
    await flush();
    d.resolve({ status: "approved", token: "too-late" });
    await flush();

    expect(events).toEqual([{ type: "code", code: "123456" }]);
  });

  it("cancel は進行中の確認を中断し、タイマーを残さない", async () => {
    const client = makeClient([{ status: "pending" }]);
    let signal: AbortSignal | undefined;
    client.pairPoll.mockImplementationOnce((_session: string, s?: AbortSignal) => {
      signal = s;
      return new Promise<PairPollResponse>(() => {});
    });
    const { session } = start(client);
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();

    session.cancel();
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("dedupeDiscovered", () => {
  const a = { name: "Desk", host: "192.168.1.10", port: 8787 };

  it("discoveredKey は host:port", () => {
    expect(discoveredKey(a)).toBe("192.168.1.10:8787");
  });

  it("新しい host:port は末尾に足す", () => {
    const b = { name: "Other", host: "192.168.1.11", port: 8787 };
    const samePortless = { name: "Alt", host: "192.168.1.10", port: 9000 };
    expect(dedupeDiscovered([a], b)).toEqual([a, b]);
    expect(dedupeDiscovered([a], samePortless)).toEqual([a, samePortless]);
  });

  it("同じ host:port は足さず、同じ配列参照を返す（再描画しない）", () => {
    const prev = [a];
    const again = { name: "Desk (renamed)", host: "192.168.1.10", port: 8787 };
    expect(dedupeDiscovered(prev, again)).toBe(prev);
  });
});
