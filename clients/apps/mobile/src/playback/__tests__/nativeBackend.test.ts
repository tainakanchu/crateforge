// core の installNativePlaybackBackend（Android ネイティブ再生バックエンド）の単体テスト。
// 偽 bridge でネイティブ側を模し、ストア⇄ネイティブの対応・hydrate・二重自動送り防止・
// 失敗時の再同期・Android Auto 起点の変更反映を検証する（design §8「11.1 JS」）。

import * as SecureStore from "expo-secure-store";

import {
  NATIVE_COMMAND_FAILED_MESSAGE,
  NATIVE_CONNECT_FAILED_MESSAGE,
  NoopAudioEngine,
  installNativePlaybackBackend,
  isNativePlaybackActive,
  usePlayer,
  type AudioEngine,
  type NativePlaybackInstallation,
  type NativePlaybackState,
  type Track,
} from "@crateforge/core";
import { resetTestState } from "@/test-utils";
import {
  FakeNativeBridge,
  deferred,
  emptyNativeState,
  flushPromises,
  makeTrack,
  snapshotOf,
} from "../__fixtures__/fakeNativeBridge";

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

let bridge: FakeNativeBridge;
let installation: NativePlaybackInstallation | null = null;

const tracks: Track[] = [makeTrack(1), makeTrack(2), makeTrack(3), makeTrack(4)];

/** ネイティブに 4 曲のキュー（index=1 再生中）がある状態で install し、ready まで待つ。 */
async function installWithQueue(): Promise<void> {
  bridge.setNativeQueue(tracks, { index: 1 });
  bridge.state = { ...bridge.state, isPlaying: true, positionMs: 1234, durationMs: 180000 };
  installation = installNativePlaybackBackend(bridge);
  await installation.ready;
}

beforeEach(() => {
  jest.clearAllMocks();
  getItem.mockResolvedValue(null);
  resetTestState();
  bridge = new FakeNativeBridge();
});

afterEach(() => {
  installation?.uninstall();
  installation = null;
});

describe("install / uninstall", () => {
  it("アクションだけを差し替え、uninstall で元の JS 実装へ戻す", async () => {
    const before = usePlayer.getState();
    expect(isNativePlaybackActive()).toBe(false);

    installation = installNativePlaybackBackend(bridge);
    await installation.ready;
    const during = usePlayer.getState();
    expect(isNativePlaybackActive()).toBe(true);
    expect(during.next).not.toBe(before.next);
    expect(during._onFinished).not.toBe(before._onFinished);
    expect(during.hydrate).not.toBe(before.hydrate);
    // 派生 getter は差し替えない（UI の selector がそのまま使える）。
    expect(during.current).toBe(before.current);
    expect(during.upNext).toBe(before.upNext);
    expect(bridge.listenerCount).toBe(2);

    installation.uninstall();
    installation = null;
    const after = usePlayer.getState();
    expect(isNativePlaybackActive()).toBe(false);
    expect(after.next).toBe(before.next);
    expect(after._onFinished).toBe(before._onFinished);
    expect(after.engine).toBe(before.engine);
    expect(bridge.listenerCount).toBe(0);
  });

  it("既に鳴っている JS エンジンは install 時に止め、エンジンは Noop にする", async () => {
    const engine: AudioEngine = Object.assign(new NoopAudioEngine(), { pause: jest.fn() });
    usePlayer.setState({ engine });
    installation = installNativePlaybackBackend(bridge);
    expect(engine.pause).toHaveBeenCalled();
    expect(usePlayer.getState().engine).toBeInstanceOf(NoopAudioEngine);
    expect(usePlayer.getState().engine).not.toBe(engine);
  });

  it("2 回目の install は前の購読を外してから入れ直す", async () => {
    const first = installNativePlaybackBackend(bridge);
    await first.ready;
    const second = new FakeNativeBridge();
    installation = installNativePlaybackBackend(second);
    await installation.ready;
    expect(bridge.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(2);
    usePlayer.getState().play();
    await flushPromises();
    expect(second.play).toHaveBeenCalledTimes(1);
    expect(bridge.play).not.toHaveBeenCalled();
  });
});

describe("ready（初回同期）", () => {
  it("connect → getQueue の結果でストアを置き換える（ネイティブが勝つ）", async () => {
    // JS 側に別のキューが残っていてもネイティブで上書きされる。
    usePlayer.setState({ queue: [makeTrack(99)], order: [0], orderPos: 0, index: 0 });
    bridge.setNativeQueue(tracks, { index: 2, order: [3, 2, 0, 1], orderPos: 1 });
    bridge.state = {
      ...bridge.state,
      isPlaying: true,
      positionMs: 4000,
      durationMs: 200000,
      shuffle: true,
      repeat: "all",
      rate: 1.5,
      sleepTimerMs: 900000,
      stopAtTrackEnd: false,
    };
    installation = installNativePlaybackBackend(bridge);
    await installation.ready;

    const st = usePlayer.getState();
    expect(st.queue.map((t) => t.trackId)).toEqual([1, 2, 3, 4]);
    expect(st.order).toEqual([3, 2, 0, 1]);
    expect(st.orderPos).toBe(1);
    expect(st.index).toBe(2);
    expect(st.current()?.trackId).toBe(3);
    expect(st.upNext().map((t) => t.trackId)).toEqual([1, 2]);
    expect(st).toMatchObject({
      isPlaying: true,
      positionMs: 4000,
      durationMs: 200000,
      shuffle: true,
      repeat: "all",
      playbackRate: 1.5,
      sleepTimerMs: 900000,
      stopAtTrackEnd: false,
    });
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(bridge.getQueue).toHaveBeenCalledTimes(1);
  });

  it("起動前から残っていたネイティブのエラーは通知しない", async () => {
    bridge.state = emptyNativeState({
      lastError: { code: "NETWORK", message: "old", trackId: 1, atEpochMs: 500 },
    });
    installation = installNativePlaybackBackend(bridge);
    await installation.ready;
    expect(usePlayer.getState().lastError).toBeNull();
    // 同じエラーが再送されても通知しない。
    bridge.emit({});
    expect(usePlayer.getState().lastError).toBeNull();
  });

  it("connect に失敗しても ready は resolve し、lastError で知らせて溜めたコマンドは送る", async () => {
    bridge.connect.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "ERR_SERVICE" }));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    installation = installNativePlaybackBackend(bridge);
    usePlayer.getState().play();
    await installation.ready;
    await flushPromises();
    expect(usePlayer.getState().lastError?.message).toBe(NATIVE_CONNECT_FAILED_MESSAGE);
    expect(bridge.play).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("hydrate（ネイティブのキューを上書きしない）", () => {
  it("Android Auto で作られたキューが SecureStore の hydrate で消えない", async () => {
    getItem.mockImplementation(async (k: string) =>
      k === "crateforge.player.shuffle" ? "true" : k === "crateforge.player.repeat" ? "all" : null,
    );
    bridge.setNativeQueue(tracks, { index: 3 });
    installation = installNativePlaybackBackend(bridge);
    // _layout と同じく ready 前に hydrate が走る。
    const hydrated = usePlayer.getState().hydrate();
    await installation.ready;
    await hydrated;

    const st = usePlayer.getState();
    expect(st.queue).toHaveLength(4);
    expect(st.index).toBe(3);
    expect(bridge.migrateLegacySettings).toHaveBeenCalledWith({ shuffle: true, repeat: "all" });
    // shuffle/repeat はネイティブの state で反映される（hydrate では直接書かない）。
    expect(st.shuffle).toBe(false);
    expect(st.repeat).toBe("off");
  });

  it("SecureStore の値が無い/不正なら null を渡す", async () => {
    getItem.mockImplementation(async (k: string) =>
      k === "crateforge.player.repeat" ? "bogus" : null,
    );
    installation = installNativePlaybackBackend(bridge);
    await installation.ready;
    await usePlayer.getState().hydrate();
    expect(bridge.migrateLegacySettings).toHaveBeenCalledWith({ shuffle: null, repeat: null });
  });

  it("移行が適用されたらネイティブの state で shuffle/repeat が反映される", async () => {
    getItem.mockImplementation(async (k: string) =>
      k === "crateforge.player.repeat" ? "one" : null,
    );
    bridge.migrateLegacySettings.mockImplementationOnce(async (s) => {
      bridge.emit({ repeat: s.repeat ?? "off", settingsInitialized: true });
      return true;
    });
    installation = installNativePlaybackBackend(bridge);
    await installation.ready;
    await usePlayer.getState().hydrate();
    expect(usePlayer.getState().repeat).toBe("one");
  });
});

describe("二重自動送りの防止", () => {
  it("_onFinished / _onError / _onProgress / _onPlayingChange は何もしない", async () => {
    await installWithQueue();
    const before = usePlayer.getState();
    before._onFinished();
    before._onError("x");
    before._onProgress(99999, 1);
    before._onPlayingChange(false);
    await flushPromises();

    const st = usePlayer.getState();
    expect(st.index).toBe(1);
    expect(st.positionMs).toBe(1234);
    expect(st.isPlaying).toBe(true);
    expect(st.lastError).toBeNull();
    expect(bridge.calls).toEqual([]);
  });

  it("setEngine は無視され、エンジンのハンドラも配線しない", async () => {
    await installWithQueue();
    const engine = Object.assign(new NoopAudioEngine(), { setHandlers: jest.fn() });
    usePlayer.getState().setEngine(engine);
    expect(engine.setHandlers).not.toHaveBeenCalled();
    expect(usePlayer.getState().engine).not.toBe(engine);
  });

  it("曲の遷移はネイティブの state 1 回だけで進む（同じ版ならキューは取り直さない）", async () => {
    await installWithQueue();
    expect(bridge.getQueue).toHaveBeenCalledTimes(1);
    bridge.emit({ index: 2, orderPos: 2, currentTrackId: 3, positionMs: 0 });
    const st = usePlayer.getState();
    expect(st.index).toBe(2);
    expect(st.orderPos).toBe(2);
    expect(st.current()?.trackId).toBe(3);
    await flushPromises();
    expect(bridge.getQueue).toHaveBeenCalledTimes(1);
    expect(bridge.calls).toEqual([]);
  });
});

describe("ストア → ネイティブのコマンド", () => {
  it("各アクションを対応するネイティブコマンドへ送る", async () => {
    await installWithQueue();
    const p = usePlayer.getState();
    const t = makeTrack(10);
    p.setQueue(tracks, 9);
    p.setQueue([], 0);
    p.playAt(2);
    p.next(true);
    p.prev();
    p.seek(-5);
    p.setRepeat("one");
    p.setShuffle(true);
    p.removeQueueAt(0);
    p.moveQueueItem(0, 3);
    p.moveUpNext(2, 3);
    p.setRate(3);
    p.setSleepTimer(15 * 60 * 1000);
    p.setStopAtTrackEnd(true);
    p.enqueue(t);
    p.enqueueNext(t);
    p.clear();
    await flushPromises();

    expect(bridge.calls).toEqual([
      "setQueue",
      "clearQueue",
      "playAt",
      "skipNext",
      "skipPrevious",
      "seekTo",
      "setRepeat",
      "setShuffle",
      "removeQueueAt",
      "moveQueueItem",
      "moveUpNext",
      "setRate",
      "setSleepTimer",
      "setStopAtTrackEnd",
      "enqueue",
      "enqueue",
      "clearQueue",
    ]);
    expect(bridge.setQueue).toHaveBeenCalledWith(tracks, 3); // startIndex は範囲に丸める
    expect(bridge.playAt).toHaveBeenCalledWith(2);
    expect(bridge.seekTo).toHaveBeenCalledWith(0);
    expect(bridge.setRepeat).toHaveBeenCalledWith("one");
    expect(bridge.setShuffle).toHaveBeenCalledWith(true);
    expect(bridge.moveQueueItem).toHaveBeenCalledWith(0, 3);
    expect(bridge.moveUpNext).toHaveBeenCalledWith(2, 3);
    expect(bridge.setRate).toHaveBeenCalledWith(2);
    expect(bridge.setSleepTimer).toHaveBeenCalledWith(900000);
    expect(bridge.setStopAtTrackEnd).toHaveBeenCalledWith(true);
    expect(bridge.enqueue).toHaveBeenNthCalledWith(1, [t], "end");
    expect(bridge.enqueue).toHaveBeenNthCalledWith(2, [t], "next");
    // shuffle/repeat はフォールバック経路用に SecureStore へも書く。
    expect(setItem).toHaveBeenCalledWith("crateforge.player.repeat", "one");
    expect(setItem).toHaveBeenCalledWith("crateforge.player.shuffle", "true");
  });

  it("楽観更新しない（ネイティブの state が来るまでストアは変わらない）", async () => {
    await installWithQueue();
    usePlayer.getState().toggle(); // isPlaying=true → pause
    await flushPromises();
    expect(bridge.pause).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().isPlaying).toBe(true);
    usePlayer.getState().setRepeat("all");
    usePlayer.getState().setRate(1.25);
    await flushPromises();
    expect(usePlayer.getState().repeat).toBe("off");
    expect(usePlayer.getState().playbackRate).toBe(1);

    bridge.emit({ isPlaying: false, repeat: "all", rate: 1.25 });
    expect(usePlayer.getState()).toMatchObject({ isPlaying: false, repeat: "all", playbackRate: 1.25 });
    usePlayer.getState().toggle(); // isPlaying=false → play
    await flushPromises();
    expect(bridge.play).toHaveBeenCalledTimes(1);
  });

  it("範囲外・無効な操作は JS 実装と同じくネイティブへ送らない", async () => {
    await installWithQueue();
    const p = usePlayer.getState();
    p.playAt(-1);
    p.playAt(4);
    p.removeQueueAt(9);
    p.moveQueueItem(1, 1);
    p.moveQueueItem(0, 7);
    // orderPos=1 なので Up Next は order 上の 2 以降。
    p.moveUpNext(1, 3);
    p.moveUpNext(3, 3);
    await flushPromises();
    expect(bridge.calls).toEqual([]);
  });

  it("スリープタイマー 0/null は解除として送る", async () => {
    await installWithQueue();
    usePlayer.getState().setSleepTimer(null);
    usePlayer.getState().setSleepTimer(0);
    await flushPromises();
    expect(bridge.setSleepTimer).toHaveBeenNthCalledWith(1, null);
    expect(bridge.setSleepTimer).toHaveBeenNthCalledWith(2, null);
  });

  it("ready 前のコマンドは溜めておき、ready 後に呼び出し順で送る", async () => {
    const connect = deferred<NativePlaybackState>();
    bridge.connect.mockImplementationOnce(() => connect.promise);
    installation = installNativePlaybackBackend(bridge);

    const p = usePlayer.getState();
    p.play();
    p.setRepeat("one");
    p.next();
    p.enqueue(makeTrack(7));
    await flushPromises();
    expect(bridge.calls).toEqual([]);

    connect.resolve({ ...bridge.state });
    await installation.ready;
    await flushPromises();
    expect(bridge.calls).toEqual(["play", "setRepeat", "skipNext", "enqueue"]);
  });
});

describe("コマンド失敗 → 再同期", () => {
  it("reject されたら connect + getQueue で取り直し、lastError を立てる", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await installWithQueue();
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(bridge.getQueue).toHaveBeenCalledTimes(1);

    // ネイティブ側は別の状態に進んでいた（JS が取りこぼしていた）想定。
    bridge.setNativeQueue([makeTrack(5), makeTrack(6)], { index: 1 });
    bridge.state = { ...bridge.state, isPlaying: false };
    bridge.skipNext.mockRejectedValueOnce(Object.assign(new Error("bad"), { code: "ERR_SERVICE" }));
    usePlayer.getState().next();
    await flushPromises(20);

    expect(bridge.connect).toHaveBeenCalledTimes(2);
    expect(bridge.getQueue).toHaveBeenCalledTimes(2);
    const st = usePlayer.getState();
    expect(st.lastError?.message).toBe(NATIVE_COMMAND_FAILED_MESSAGE);
    expect(st.queue.map((t) => t.trackId)).toEqual([5, 6]);
    expect(st.index).toBe(1);
    expect(st.isPlaying).toBe(false);
    warn.mockRestore();
  });

  it("連続失敗でも resync は多重起動しない", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await installWithQueue();
    const slow = deferred<NativePlaybackState>();
    bridge.connect.mockImplementationOnce(() => slow.promise);
    bridge.play.mockRejectedValueOnce(new Error("a"));
    bridge.pause.mockRejectedValueOnce(new Error("b"));
    usePlayer.getState().play();
    usePlayer.getState().pause();
    await flushPromises();
    // 1 本目の resync が進行中なので connect は 1 回だけ追加。
    expect(bridge.connect).toHaveBeenCalledTimes(2);
    slow.resolve({ ...bridge.state });
    await flushPromises(20);
    // 実行中に来た 2 件目の失敗分としてもう 1 回だけ取り直す。
    expect(bridge.connect).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("clearError の失敗では lastError を立て直さない（通知ループ防止）", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await installWithQueue();
    usePlayer.setState({ lastError: { message: "x", at: 1 } });
    bridge.clearError.mockRejectedValueOnce(new Error("nope"));
    usePlayer.getState().clearError();
    expect(usePlayer.getState().lastError).toBeNull();
    await flushPromises(20);
    expect(usePlayer.getState().lastError).toBeNull();
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("ネイティブ（Android Auto 等）起点の変更", () => {
  it("queueVersion が進んだら getQueue で取り直して反映する", async () => {
    await installWithQueue();
    // 車載側で別のアルバムを再生開始。
    const album = [makeTrack(20), makeTrack(21), makeTrack(22)];
    bridge.setNativeQueue(album, { index: 0 });
    bridge.emit({ isPlaying: true, positionMs: 0 });
    await flushPromises();

    const st = usePlayer.getState();
    expect(bridge.getQueue).toHaveBeenCalledTimes(2);
    expect(st.queue.map((t) => t.trackId)).toEqual([20, 21, 22]);
    expect(st.index).toBe(0);
    expect(st.current()?.trackId).toBe(20);
    expect(bridge.calls).toEqual([]);
  });

  it("版が揃うまでは index/orderPos を古いキューへ当てはめない", async () => {
    await installWithQueue();
    const pending = deferred<ReturnType<typeof snapshotOf>>();
    bridge.getQueue.mockImplementationOnce(() => pending.promise);
    const album = [makeTrack(30), makeTrack(31)];
    bridge.setNativeQueue(album, { index: 0 });
    bridge.emit({});
    // 取得中：新しい index=0 を旧キュー（4 曲）に当てはめず、旧 index=1 のまま。
    expect(usePlayer.getState().index).toBe(1);
    expect(usePlayer.getState().current()?.trackId).toBe(2);
    pending.resolve(snapshotOf(album, { queueVersion: bridge.state.queueVersion, index: 0 }));
    await flushPromises();
    expect(usePlayer.getState().index).toBe(0);
    expect(usePlayer.getState().current()?.trackId).toBe(30);
  });

  it("古い getQueue 応答は捨てる（queueVersion の順序）", async () => {
    await installWithQueue();
    const seen: number[][] = [];
    const unsub = usePlayer.subscribe((s, prev) => {
      if (s.queue !== prev.queue) seen.push(s.queue.map((t) => t.trackId));
    });

    const stale = deferred<ReturnType<typeof snapshotOf>>();
    bridge.getQueue.mockImplementationOnce(() => stale.promise);
    // v2: 曲 40 だけ
    bridge.setNativeQueue([makeTrack(40)]);
    const v2 = bridge.state.queueVersion;
    bridge.emit({});
    // v3: 曲 50, 51（取得中にさらに変化）
    bridge.setNativeQueue([makeTrack(50), makeTrack(51)]);
    bridge.emit({});
    // 先に投げた v2 の応答が後から届く。
    stale.resolve(snapshotOf([makeTrack(40)], { queueVersion: v2 }));
    await flushPromises(20);

    expect(seen).toEqual([[50, 51]]);
    expect(usePlayer.getState().queue.map((t) => t.trackId)).toEqual([50, 51]);
    unsub();
  });

  it("同じ版を取得中に届いた state では getQueue を重ねない", async () => {
    await installWithQueue();
    const pending = deferred<ReturnType<typeof snapshotOf>>();
    bridge.getQueue.mockImplementationOnce(() => pending.promise);
    bridge.setNativeQueue([makeTrack(60), makeTrack(61)]);
    bridge.emit({});
    bridge.emit({ isBuffering: true });
    bridge.emit({ isBuffering: false, isPlaying: true });
    expect(bridge.getQueue).toHaveBeenCalledTimes(2); // ready の 1 回 + 今回の 1 回
    pending.resolve(snapshotOf([makeTrack(60), makeTrack(61)], { queueVersion: bridge.state.queueVersion }));
    await flushPromises(20);
    expect(bridge.getQueue).toHaveBeenCalledTimes(2);
    expect(usePlayer.getState().queue.map((t) => t.trackId)).toEqual([60, 61]);
  });

  it("shuffle/repeat/速度/スリープ/曲終わり停止はネイティブの state で反映する", async () => {
    await installWithQueue();
    bridge.emit({
      shuffle: true,
      repeat: "one",
      rate: 0.75,
      sleepTimerMs: 1800000,
      sleepTimerEndsAtEpochMs: Date.now() + 1800000,
      stopAtTrackEnd: false,
    });
    expect(usePlayer.getState()).toMatchObject({
      shuffle: true,
      repeat: "one",
      playbackRate: 0.75,
      sleepTimerMs: 1800000,
      stopAtTrackEnd: false,
    });
    // スリープ満了（ネイティブが pause + 解除）。
    bridge.emit({ isPlaying: false, sleepTimerMs: null, sleepTimerEndsAtEpochMs: null });
    expect(usePlayer.getState()).toMatchObject({ isPlaying: false, sleepTimerMs: null });
  });

  it("progress イベントは位置・長さ・再生中だけを反映する", async () => {
    await installWithQueue();
    bridge.emitProgress({ positionMs: 61000, durationMs: 180000, isPlaying: true });
    const st = usePlayer.getState();
    expect(st).toMatchObject({ positionMs: 61000, durationMs: 180000, isPlaying: true, index: 1 });
  });

  it("ネイティブのエラーは code 付きで 1 回だけ lastError に出る", async () => {
    await installWithQueue();
    const err = { code: "UNSUPPORTED_FORMAT" as const, message: "この形式は再生できません", trackId: 2, atEpochMs: 1000 };
    bridge.emit({ lastError: err });
    expect(usePlayer.getState().lastError).toEqual({ message: err.message, at: 1000, code: "UNSUPPORTED_FORMAT" });

    usePlayer.getState().clearError();
    expect(usePlayer.getState().lastError).toBeNull();
    await flushPromises();
    expect(bridge.clearError).toHaveBeenCalledTimes(1);
    // ネイティブ側の clearError 反映前に同じエラーの state が来ても再通知しない。
    bridge.emit({ positionMs: 10 });
    expect(usePlayer.getState().lastError).toBeNull();
    // 新しいエラー（atEpochMs が違う）は通知する。
    bridge.emit({ lastError: { ...err, code: "TOO_MANY_FAILURES", message: "再生できない曲が続いたため停止しました", atEpochMs: 2000 } });
    expect(usePlayer.getState().lastError).toMatchObject({ at: 2000, code: "TOO_MANY_FAILURES" });
  });

  it("resync() はイベント無しでもネイティブの現状態を取り直す（lastError は立てない）", async () => {
    await installWithQueue();
    // イベントを取りこぼした想定：ネイティブ側だけが進んでいる。
    bridge.setNativeQueue([makeTrack(70), makeTrack(71), makeTrack(72)], { index: 2 });
    bridge.state = { ...bridge.state, isPlaying: false, repeat: "all" };
    await installation!.resync();
    const st = usePlayer.getState();
    expect(st.queue.map((t) => t.trackId)).toEqual([70, 71, 72]);
    expect(st.index).toBe(2);
    expect(st).toMatchObject({ isPlaying: false, repeat: "all", lastError: null });
  });

  it("uninstall 後のイベントは無視する", async () => {
    await installWithQueue();
    const emitState = bridge.addStateListener.mock.calls[0][0];
    installation?.uninstall();
    installation = null;
    emitState({ ...bridge.state, index: 3, revision: 99 });
    expect(usePlayer.getState().index).toBe(1);
  });
});
