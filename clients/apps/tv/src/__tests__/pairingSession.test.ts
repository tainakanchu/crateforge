// core/src/pairing/pairingSession.ts のテスト（core に jest 設定が無いためアプリのテストツリーに置く）。
// pairStart → 2 秒ごとの pairPoll → approved / expired / error の状態機械を偽タイマーで確認する。
// ApiClient の pairStart / pairPoll 自体（URL・ヘッダ）は pairClient.test.ts で見ている。

import {
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
    pairPoll: jest.fn(async (_session: string): Promise<PairPollResponse> => {
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
    expect(client.pairPoll).toHaveBeenCalledWith("sess-1");

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

  it("前回の確認が返るまで次の確認を投げず、approved は 1 回だけ通知する", async () => {
    const client = makeClient([{ status: "approved", token: "second" }]);
    const d = deferred<PairPollResponse>();
    client.pairPoll.mockReturnValueOnce(d.promise);
    const { events } = start(client);
    await flush();

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
