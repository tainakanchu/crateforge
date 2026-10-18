// テスト用の偽ネイティブ再生 bridge（core の NativePlaybackBridge を満たす）。
// ネイティブ側の state / キューを手元で持ち、emit でイベント（onStateChange / onProgress）を発火する。
// コマンドは jest.fn で呼び出しを記録するだけ（状態遷移はテストが emit で明示する）。

import type {
  NativePlaybackBridge,
  NativePlaybackState,
  NativeProgressEvent,
  NativeQueueSnapshot,
  Track,
} from "@crateforge/core";

export function makeTrack(trackId: number, over: Partial<Track> = {}): Track {
  return {
    id: trackId,
    trackId,
    persistentId: null,
    name: `Song ${trackId}`,
    artist: "Artist",
    albumArtist: null,
    composer: null,
    album: "Album",
    genre: null,
    year: null,
    rating: null,
    playCount: null,
    skipCount: null,
    totalTimeMs: 180000,
    dateAdded: null,
    dateModified: null,
    bpm: null,
    comments: null,
    locationRaw: null,
    locationPath: `/music/${trackId}.mp3`,
    trackType: null,
    disabled: false,
    compilation: false,
    discNumber: null,
    discCount: null,
    trackNumber: null,
    trackCount: null,
    fileExists: true,
    lastPlayed: null,
    ...over,
  };
}

export function emptyNativeState(over: Partial<NativePlaybackState> = {}): NativePlaybackState {
  return {
    revision: 0,
    queueVersion: 0,
    queueLength: 0,
    index: -1,
    orderPos: -1,
    currentTrackId: null,
    currentScope: null,
    isPlaying: false,
    isBuffering: false,
    positionMs: 0,
    durationMs: 0,
    isSeekable: true,
    shuffle: false,
    repeat: "off",
    rate: 1,
    sleepTimerMs: null,
    sleepTimerEndsAtEpochMs: null,
    stopAtTrackEnd: false,
    lastError: null,
    settingsInitialized: false,
    ...over,
  };
}

/** キューのスナップショットを作る（order 省略時は自然順）。 */
export function snapshotOf(
  tracks: Track[],
  opts: { queueVersion: number; index?: number; order?: number[]; orderPos?: number },
): NativeQueueSnapshot {
  const order = opts.order ?? tracks.map((_, i) => i);
  const index = opts.index ?? (tracks.length > 0 ? 0 : -1);
  return {
    queueVersion: opts.queueVersion,
    items: tracks.map((t) => ({
      scope: "legacy",
      trackId: t.trackId,
      track: t as unknown as NativeQueueSnapshot["items"][number]["track"],
    })),
    order,
    orderPos: opts.orderPos ?? order.indexOf(index),
    index,
  };
}

type Listener<T> = (v: T) => void;

/** jest.fn の戻り値を Promise<void> に固定した型。 */
type VoidCommand<A extends unknown[]> = jest.Mock<Promise<void>, A>;

export class FakeNativeBridge implements NativePlaybackBridge {
  state: NativePlaybackState = emptyNativeState();
  queue: NativeQueueSnapshot = snapshotOf([], { queueVersion: 0 });

  private stateListeners = new Set<Listener<NativePlaybackState>>();
  private progressListeners = new Set<Listener<NativeProgressEvent>>();

  /** コマンドの呼び出し順（名前のみ）。 */
  readonly calls: string[] = [];

  connect = jest.fn(async () => ({ ...this.state }));
  getQueue = jest.fn(async () => structuredCloneSnapshot(this.queue));

  addStateListener = jest.fn((l: Listener<NativePlaybackState>) => {
    this.stateListeners.add(l);
    return { remove: () => void this.stateListeners.delete(l) };
  });
  addProgressListener = jest.fn((l: Listener<NativeProgressEvent>) => {
    this.progressListeners.add(l);
    return { remove: () => void this.progressListeners.delete(l) };
  });

  setQueue = this.command<[Track[], number]>("setQueue");
  playAt = this.command<[number]>("playAt");
  play = this.command<[]>("play");
  pause = this.command<[]>("pause");
  seekTo = this.command<[number]>("seekTo");
  skipNext = this.command<[]>("skipNext");
  skipPrevious = this.command<[]>("skipPrevious");
  setShuffle = this.command<[boolean]>("setShuffle");
  setRepeat = this.command<["off" | "all" | "one"]>("setRepeat");
  setRate = this.command<[number]>("setRate");
  enqueue = this.command<[Track[], "end" | "next"]>("enqueue");
  removeQueueAt = this.command<[number]>("removeQueueAt");
  moveQueueItem = this.command<[number, number]>("moveQueueItem");
  moveUpNext = this.command<[number, number]>("moveUpNext");
  clearQueue = this.command<[]>("clearQueue");
  setSleepTimer = this.command<[number | null]>("setSleepTimer");
  setStopAtTrackEnd = this.command<[boolean]>("setStopAtTrackEnd");
  clearError = this.command<[]>("clearError");
  migrateLegacySettings = jest.fn(
    async (_s: { shuffle: boolean | null; repeat: "off" | "all" | "one" | null }) => {
      this.calls.push("migrateLegacySettings");
      return true;
    },
  );

  /** 購読中のリスナー数（解除の検証用）。 */
  get listenerCount(): number {
    return this.stateListeners.size + this.progressListeners.size;
  }

  /** ネイティブのキューを差し替える（queueVersion を進め、state も合わせる）。 */
  setNativeQueue(
    tracks: Track[],
    opts: { index?: number; order?: number[]; orderPos?: number } = {},
  ): void {
    const queueVersion = this.state.queueVersion + 1;
    this.queue = snapshotOf(tracks, { queueVersion, ...opts });
    this.state = {
      ...this.state,
      queueVersion,
      queueLength: tracks.length,
      index: this.queue.index,
      orderPos: this.queue.orderPos,
      currentTrackId: this.queue.index >= 0 ? tracks[this.queue.index].trackId : null,
    };
  }

  /** state を更新して onStateChange を発火する（revision は自動で進む）。 */
  emit(partial: Partial<NativePlaybackState> = {}): void {
    this.state = { ...this.state, ...partial, revision: this.state.revision + 1 };
    const snapshot = { ...this.state };
    for (const l of [...this.stateListeners]) l(snapshot);
  }

  emitProgress(p: NativeProgressEvent): void {
    for (const l of [...this.progressListeners]) l(p);
  }

  private command<A extends unknown[]>(name: string): VoidCommand<A> {
    return jest.fn(async (..._args: A) => {
      this.calls.push(name);
    });
  }
}

function structuredCloneSnapshot(s: NativeQueueSnapshot): NativeQueueSnapshot {
  return { ...s, items: s.items.map((i) => ({ ...i })), order: [...s.order] };
}

/** 外から resolve/reject できる Promise。 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 保留中のマイクロタスク（Promise チェーン）を流し切る。 */
export async function flushPromises(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
