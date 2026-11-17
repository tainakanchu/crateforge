// キーごとに遅延取得した値のキャッシュ (展開したアルバムの曲・アーティストのアルバムなど)。
// React に依存しない (tests/desktop/keyedCache.test.ts で固定)。配線は hooks/useKeyedCache.ts。

/**
 * - `load` は新しい値があればそれを返し、無ければ取得して覚える。同じキーの取得が重なったら 1 回にまとめる。
 * - `markAllStale` (ライブラリの変更): 値は表示用に残すが、次の `load` で取り直す。
 * - `reset` (一覧の切り替え): 全部捨てる。切り替え前に始めた取得の結果は覚えない
 *   (同じキーでも、範囲が違えば中身が違う)。
 * - 取得に失敗したキーは `isFailed` で分かる (次の `load` で消える)。
 */
export class KeyedCache<V> {
  private values = new Map<string, V>();
  private stale = new Set<string>();
  private failed = new Set<string>();
  private inflight = new Map<string, Promise<V>>();
  private generation = 0;
  private readonly onChange: () => void;

  constructor(onChange: () => void = () => {}) {
    this.onChange = onChange;
  }

  /** 覚えている値 (取り直し待ちの古い値でも返す)。 */
  get(key: string): V | undefined {
    return this.values.get(key);
  }

  isFailed(key: string): boolean {
    return this.failed.has(key);
  }

  keys(): string[] {
    return [...this.values.keys()];
  }

  /** 値を (あれば使い、無ければ・古ければ取得して) 返す。失敗は throw する。 */
  load(key: string, fetch: () => Promise<V>): Promise<V> {
    const cached = this.values.get(key);
    if (cached !== undefined && !this.stale.has(key)) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;
    const generation = this.generation;
    if (this.failed.delete(key)) this.onChange(); // 再試行中は「取得中」の表示に戻す
    const promise = fetch().then(
      (value) => {
        if (generation === this.generation) {
          this.inflight.delete(key);
          this.values.set(key, value);
          this.stale.delete(key);
          this.onChange();
        }
        return value;
      },
      (err) => {
        if (generation === this.generation) {
          this.inflight.delete(key);
          this.failed.add(key);
          this.onChange();
        }
        throw err;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  /** 覚えている値を書き換える (操作の結果を先に反映する)。同じ値を返したら何もしない。 */
  update(key: string, updater: (value: V) => V): void {
    const value = this.values.get(key);
    if (value === undefined) return;
    const next = updater(value);
    if (next === value) return;
    this.values.set(key, next);
    this.onChange();
  }

  /** 全部を「取り直し待ち」にする。値は表示用に残す。 */
  markAllStale(): void {
    for (const key of this.values.keys()) this.stale.add(key);
    // 取り直し前に始めた取得の結果は古いかもしれないので、覚えない。
    this.generation += 1;
    this.inflight.clear();
  }

  /** 全部捨てる。 */
  reset(): void {
    this.generation += 1;
    this.inflight.clear();
    const had = this.values.size > 0 || this.failed.size > 0;
    this.values.clear();
    this.stale.clear();
    this.failed.clear();
    if (had) this.onChange();
  }
}
