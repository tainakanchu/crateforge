// 一覧のウィンドウ取得 (件数ぶんのスクロール範囲 + 見えているページだけ取得) の純粋な部分。
// React / DOM / Tauri に依存しない (tests/desktop/windowedList.test.ts で固定)。
// 仕様は docs/library-list/design.md §1–2。配線は hooks/useWindowedList.ts。

/** 1 ページの件数。 */
export const WINDOW_PAGE_SIZE = 200;
/** キャッシュに残すページ数の上限 (表示中のページはこれを超えても捨てない)。 */
export const WINDOW_MAX_PAGES = 20;
/** 表示範囲の前後に先読みするページ数。 */
export const WINDOW_PREFETCH_PAGES = 1;
/** 失敗したページを自動で取り直すまでの待ち時間 (ms)。2 回まで再試行し、だめなら失敗として見せる。 */
export const WINDOW_RETRY_DELAYS_MS: readonly number[] = [400, 1200];
/** 離れた位置へ跳んだとき、取得を始めるまでスクロールの停止を待つ時間 (ms)。 */
export const WINDOW_SETTLE_MS = 100;
/** 表示中の項目の範囲 (通し番号。両端を含む)。 */
export interface IndexRange {
  start: number;
  end: number;
}

/** 通し番号 index の項目が入っているページ番号。 */
export function pageOf(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / pageSize);
}

/** count 件を pageSize 件ずつに区切ったときのページ数。 */
export function pageCount(count: number, pageSize: number): number {
  return count <= 0 ? 0 : Math.ceil(count / pageSize);
}

/**
 * range と重なるページ + 前後 prefetch ページを、取得する優先順で返す
 * (表示中のページ → 後ろの先読み → 前の先読み)。count の外のページは含めない。
 */
export function pagesForRange(
  range: IndexRange,
  count: number,
  pageSize: number,
  prefetch: number = WINDOW_PREFETCH_PAGES,
): number[] {
  const total = pageCount(count, pageSize);
  if (total === 0 || range.end < range.start) return [];
  const last = total - 1;
  const first = Math.min(last, pageOf(range.start, pageSize));
  const lastVisible = Math.min(last, pageOf(range.end, pageSize));
  const out: number[] = [];
  for (let p = first; p <= lastVisible; p++) out.push(p);
  for (let i = 1; i <= prefetch; i++) if (lastVisible + i <= last) out.push(lastVisible + i);
  for (let i = 1; i <= prefetch; i++) if (first - i >= 0) out.push(first - i);
  return out;
}

export type FetchTiming = "now" | "settle";

/**
 * 足りないページをすぐ取るか、スクロールが止まるのを待つか。
 *
 * すぐ取るのは「普通のスクロール」のときだけ:
 * - 表示中のページ (visible) がすべて手元にある (キャッシュ済み)。足りないのは先読みぶんだけで、
 *   先読みが追いついている。
 * - かつ、直前の表示範囲からの移動 (moved 件) が 1 ページの 1/4 未満。
 *
 * どちらかを外れるのは、スクロールバーを引いた・離れた位置へ跳んだときなので、止まるまで待つ。
 * こうすると、スクロールバーを引いているあいだ、通過したページを 1 つずつ取りに行かない。
 */
export function fetchTiming(
  visible: readonly number[],
  isKnown: (page: number) => boolean,
  moved: number,
  pageSize: number,
): FetchTiming {
  if (Math.abs(moved) >= pageSize / 4) return "settle";
  return visible.every(isKnown) ? "now" : "settle";
}

interface CachedPage<T> {
  items: readonly T[];
  /** 取り直し待ち (古い内容を表示し続けているだけ)。 */
  stale: boolean;
}

/**
 * ページ単位の LRU キャッシュ。
 *
 * Map の挿入順を「最近使った順」として使う (使ったら末尾へ付け直す)。上限を超えたら先頭
 * (最も使っていないページ) から捨てるが、`keep` に含まれるページ (表示中) は捨てない。
 */
export class PageCache<T> {
  private pages = new Map<number, CachedPage<T>>();
  readonly pageSize: number;
  readonly maxPages: number;

  constructor(pageSize: number = WINDOW_PAGE_SIZE, maxPages: number = WINDOW_MAX_PAGES) {
    this.pageSize = pageSize;
    this.maxPages = maxPages;
  }

  get size(): number {
    return this.pages.size;
  }

  /** ページを持っているか (取り直し待ちの古い内容でも true)。 */
  has(page: number): boolean {
    return this.pages.has(page);
  }

  /** ページを持っていて、取り直し待ちでないか。 */
  isFresh(page: number): boolean {
    const p = this.pages.get(page);
    return p !== undefined && !p.stale;
  }

  /** 通し番号 index の項目。未取得なら undefined。LRU の順序は変えない。 */
  itemAt(index: number): T | undefined {
    if (index < 0) return undefined;
    return this.pages.get(pageOf(index, this.pageSize))?.items[index % this.pageSize];
  }

  /** ページを入れ (新しい内容になる)、上限を超えたぶんを捨てる。 */
  set(page: number, items: readonly T[], keep: readonly number[] = []): void {
    this.pages.delete(page);
    this.pages.set(page, { items, stale: false });
    this.evict(keep);
  }

  /** 使ったページを「最近使った」側へ寄せる (持っていないページは無視)。 */
  touch(pages: readonly number[]): void {
    for (const page of pages) {
      const p = this.pages.get(page);
      if (!p) continue;
      this.pages.delete(page);
      this.pages.set(page, p);
    }
  }

  /**
   * 取り直しの準備: keep のページだけ残して「取り直し待ち」にし、ほかは捨てる。
   * 残したページは、新しい内容が届くまで古い内容のまま表示に使う。
   */
  invalidate(keep: readonly number[]): void {
    const keepSet = new Set(keep);
    for (const [page, p] of this.pages) {
      if (keepSet.has(page)) p.stale = true;
      else this.pages.delete(page);
    }
  }

  /** count 件に収まらないページを捨て、最後のページのはみ出しを切る。 */
  truncate(count: number): void {
    const total = pageCount(count, this.pageSize);
    for (const [page, p] of this.pages) {
      if (page >= total) {
        this.pages.delete(page);
        continue;
      }
      const max = Math.min(this.pageSize, count - page * this.pageSize);
      if (p.items.length > max) p.items = p.items.slice(0, max);
    }
  }

  /**
   * count 件に対して短いページ (件数が増えて、続きがあるはずのページ) を「取り直し待ち」にする。
   * 件数が増えたとき、最後のページの続きが未取得のまま残らないようにする。
   */
  staleShortPages(count: number): void {
    for (const [page, p] of this.pages) {
      const expected = Math.min(this.pageSize, count - page * this.pageSize);
      if (p.items.length < expected) p.stale = true;
    }
  }

  /**
   * 持っているページを並べ替える (プレイリストの手動並べ替えの先行表示)。
   * itemAt(通し番号) が新しい並びでの項目を返す。1 つでも返せない項目があるページは捨てる
   * (次の取得で埋まる)。新しい内容として扱う (取り直し待ちにはしない)。
   */
  remap(itemAt: (index: number) => T | undefined): void {
    for (const [page, p] of this.pages) {
      const next: T[] = [];
      for (let i = 0; i < p.items.length; i++) {
        const item = itemAt(page * this.pageSize + i);
        if (item === undefined) break;
        next.push(item);
      }
      if (next.length === p.items.length) p.items = next;
      else this.pages.delete(page);
    }
  }

  clear(): void {
    this.pages.clear();
  }

  /** 持っているページ番号 (最も使っていない順)。 */
  pageNumbers(): number[] {
    return [...this.pages.keys()];
  }

  /** 持っている項目を [通し番号, 項目] で列挙する (ページ番号の昇順)。 */
  *entries(): IterableIterator<[number, T]> {
    const sorted = [...this.pages.keys()].sort((a, b) => a - b);
    for (const page of sorted) {
      const items = this.pages.get(page)!.items;
      for (let i = 0; i < items.length; i++) yield [page * this.pageSize + i, items[i]];
    }
  }

  private evict(keep: readonly number[]): void {
    if (this.pages.size <= this.maxPages) return;
    const keepSet = new Set(keep);
    for (const page of [...this.pages.keys()]) {
      if (this.pages.size <= this.maxPages) return;
      if (!keepSet.has(page)) this.pages.delete(page);
    }
  }
}

/**
 * 行番号の範囲 [a, b] (順不同・両端を含む) を count に収めて返す。空なら null。
 * 範囲選択 (Shift クリック / Shift+矢印) の切り出しに使う。
 */
export function clampRange(a: number, b: number, count: number): IndexRange | null {
  if (count <= 0) return null;
  const start = Math.max(0, Math.min(a, b));
  const end = Math.min(count - 1, Math.max(a, b));
  return end < start ? null : { start, end };
}

/** カーソル移動のキー。 */
export type CursorKey = "ArrowUp" | "ArrowDown" | "PageUp" | "PageDown" | "Home" | "End";

export function isCursorKey(key: string): key is CursorKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "PageUp" ||
    key === "PageDown" ||
    key === "Home" ||
    key === "End"
  );
}

/**
 * カーソル移動後の行番号。current が null (カーソルなし) のとき、下方向のキーは先頭、
 * 上方向のキーは末尾から始める。pageRows は 1 画面ぶんの行数。count が 0 なら null。
 */
export function moveCursor(
  key: CursorKey,
  current: number | null,
  count: number,
  pageRows: number,
): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  const down = key === "ArrowDown" || key === "PageDown";
  if (current === null) return down ? 0 : last;
  const step = key === "ArrowDown" || key === "ArrowUp" ? 1 : Math.max(1, Math.floor(pageRows));
  return Math.max(0, Math.min(last, current + (down ? step : -step)));
}

export interface WindowLoaderOptions<T> {
  /** offset から limit 件を取得する。 */
  fetchPage: (offset: number, limit: number) => Promise<T[]>;
  /** ページが届いた (取得済みの内容が変わった) とき。 */
  onChange: () => void;
  /** ページの取得が (再試行しても) 失敗したとき (世代ごとに 1 回)。 */
  onError?: (err: unknown) => void;
  pageSize?: number;
  maxPages?: number;
  settleMs?: number;
  /** 失敗したページを取り直すまでの待ち時間 (ms)。要素数が自動で再試行する回数。 */
  retryDelaysMs?: readonly number[];
}

/** 一覧の同一性 (key)・取り直しの合図 (revision)・全件数 (count)。 */
export interface WindowTarget {
  key: string;
  /**
   * 並び順だけが違う一覧に共通の名前 (省略時は key)。key が変わっても group が同じなら
   * (= 並び順の変更)、先頭のページを古い内容のまま残し、新しい並びが届くまで表示に使う。
   */
  group?: string;
  revision: unknown;
  count: number;
}

/**
 * ウィンドウ取得の本体 (React に依存しない)。hooks/useWindowedList.ts が薄く包む。
 *
 * - 世代: key / revision が変わるたびに進め、古い世代の応答は捨てる。
 * - 重複排除: 取得中のページは世代ごとに覚え、同じページを二重に取らない。
 * - キャッシュ: {@link PageCache} (LRU)。revision の変化では表示中のページを古い内容のまま残す。
 * - タイミング: {@link fetchTiming}。key の切り替え直後と取り直しは待たずに取る。
 * - 失敗: 少し待って自動で取り直す ({@link WINDOW_RETRY_DELAYS_MS})。それでもだめなページは
 *   「失敗」として覚え、勝手には取り直さない ({@link retryFailed} で取り直す)。
 */
export class WindowLoader<T> {
  readonly pageSize: number;
  private readonly settleMs: number;
  private readonly cache: PageCache<T>;
  private readonly inflight = new Map<number, Promise<void>>();
  private opts: WindowLoaderOptions<T>;
  private target: WindowTarget = { key: "", revision: undefined, count: 0 };
  private started = false;
  private generation = 0;
  private range: IndexRange | null = null;
  /** 次の取得は待たずに始める (key の切り替え直後・取り直し)。 */
  private eager = true;
  private errorReported = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly retryDelaysMs: readonly number[];
  /** ページごとの失敗回数 (この世代)。 */
  private readonly attempts = new Map<number, number>();
  /** 再試行を待っているページ。 */
  private readonly retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** 再試行しても取れなかったページ。 */
  private readonly failed = new Set<number>();
  /** ページの結果 (届いた・再試行しても取れなかった・一覧が切り替わった) を待っている呼び出し。 */
  private readonly waiters = new Map<number, (() => void)[]>();

  constructor(opts: WindowLoaderOptions<T>) {
    this.opts = opts;
    this.pageSize = opts.pageSize ?? WINDOW_PAGE_SIZE;
    this.settleMs = opts.settleMs ?? WINDOW_SETTLE_MS;
    this.retryDelaysMs = opts.retryDelaysMs ?? WINDOW_RETRY_DELAYS_MS;
    this.cache = new PageCache<T>(this.pageSize, opts.maxPages ?? WINDOW_MAX_PAGES);
  }

  /** コールバックを最新のものに差し替える (取得中の応答も新しいほうへ届く)。 */
  setCallbacks(opts: Pick<WindowLoaderOptions<T>, "fetchPage" | "onChange" | "onError">): void {
    this.opts = { ...this.opts, ...opts };
  }

  get count(): number {
    return this.target.count;
  }

  /**
   * 対象の一覧を反映する。取得は始めない (続けて {@link schedule} を呼ぶ)。
   * 同じ値で何度呼んでも結果は変わらない。
   */
  sync(next: WindowTarget): void {
    if (!this.started || this.target.key !== next.key) {
      const sameGroup =
        this.started && (this.target.group ?? this.target.key) === (next.group ?? next.key);
      this.started = true;
      this.newGeneration();
      // 一覧が切り替わったら呼び出し側は先頭へスクロールを戻す。表示範囲も先頭へ戻しておき、
      // 範囲が伝え直されなくても (先頭にいたまま切り替わったときなど) 先頭のページを取れるようにする。
      this.range = this.range ? { start: 0, end: this.range.end - this.range.start } : null;
      // 並び順だけの変更なら、先頭のページは古い並びのまま残して空白にしない (届いたら入れ替わる)。
      if (sameGroup) this.cache.invalidate(this.wantedPages());
      else this.cache.clear();
    } else if (!Object.is(this.target.revision, next.revision)) {
      this.newGeneration();
      this.cache.invalidate(this.wantedPages());
    }
    if (this.target.count !== next.count) {
      // 減ったぶんは捨てる。増えたときは、最後のページの続きを取り直す (短いページを残さない)。
      this.cache.truncate(next.count);
      this.cache.staleShortPages(next.count);
    }
    this.target = { ...next };
  }

  /** 取得をやめ、届いていない応答を捨てる (アンマウント時)。あとで {@link schedule} すれば再開する。 */
  stop(): void {
    this.newGeneration();
  }

  /** 通し番号 index の項目。未取得なら undefined。 */
  get(index: number): T | undefined {
    return index < this.target.count ? this.cache.itemAt(index) : undefined;
  }

  /** 取得済みの項目を [通し番号, 項目] で列挙する。 */
  loaded(): IterableIterator<[number, T]> {
    return this.cache.entries();
  }

  /** 表示中の項目の範囲 (通し番号。両端を含む) を伝える。 */
  setVisibleRange(start: number, end: number): void {
    if (this.range && this.range.start === start && this.range.end === end) return;
    const moved = this.range ? start - this.range.start : 0;
    this.range = { start, end };
    this.schedule(moved);
  }

  /**
   * 表示範囲に足りないページを、すぐ / スクロールが止まってから取得する。
   * moved は直前の表示範囲からの移動量 (件数)。
   */
  schedule(moved: number = 0): void {
    const wanted = this.wantedPages();
    this.cache.touch(wanted);
    const missing = wanted.filter((p) => this.isMissing(p));
    if (missing.length === 0) return;
    const visible = this.range
      ? pagesForRange(this.range, this.target.count, this.pageSize, 0)
      : [];
    const timing = this.eager
      ? "now"
      : fetchTiming(visible, (p) => this.cache.has(p), moved, this.pageSize);
    clearTimeout(this.timer);
    if (timing === "now") {
      this.eager = false;
      this.request(missing);
      return;
    }
    // 待っているあいだに範囲が動くので、止まった時点で見えている範囲を取る。
    this.timer = setTimeout(
      () => this.request(this.wantedPages().filter((p) => this.isMissing(p))),
      this.settleMs,
    );
  }

  /**
   * 持っているページを並べ替える (先行表示)。itemAt は新しい並びでの通し番号 → 項目。
   * 取得中の応答は古い並びなので捨てる (続けて {@link schedule} すれば取り直す)。
   */
  remap(itemAt: (index: number) => T | undefined): void {
    this.newGeneration();
    this.eager = false;
    this.cache.remap(itemAt);
    this.opts.onChange();
    this.schedule();
  }

  /** 表示中のページのどれかが、再試行しても取れなかったか (再試行の案内を出す)。 */
  hasFailedVisible(): boolean {
    if (!this.range || this.failed.size === 0) return false;
    return pagesForRange(this.range, this.target.count, this.pageSize, 0).some((p) =>
      this.failed.has(p),
    );
  }

  /** 失敗したページを取り直す (利用者の操作から)。 */
  retryFailed(): void {
    if (this.failed.size === 0) return;
    this.failed.clear();
    this.attempts.clear();
    this.errorReported = false;
    this.eager = true;
    this.opts.onChange();
    this.schedule();
  }

  /** index の項目を (未取得なら取得して) 返す。待つあいだに一覧が切り替わったら undefined。 */
  async ensure(index: number): Promise<T | undefined> {
    if (index < 0 || index >= this.target.count) return undefined;
    const generation = this.generation;
    const page = pageOf(index, this.pageSize);
    if (!this.cache.isFresh(page)) {
      // 明示的に求められたページは、失敗済み・再試行待ちでもすぐ取りに行く。
      this.failed.delete(page);
      this.cancelRetry(page);
      this.request([page]);
      // 最初の失敗では返さず、自動の再試行の結果 (届いた / あきらめた) まで待つ。
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(page) ?? [];
        list.push(resolve);
        this.waiters.set(page, list);
      });
      if (generation !== this.generation) return undefined;
    }
    return this.cache.itemAt(index);
  }

  /** page の結果が出た (または待つ意味が無くなった) ことを、待っている呼び出しへ知らせる。 */
  private settle(page: number): void {
    const list = this.waiters.get(page);
    if (!list) return;
    this.waiters.delete(page);
    for (const resolve of list) resolve();
  }

  /** 取りに行くべきページか (新しい内容が無く、取得中・再試行待ち・失敗済みでもない)。 */
  private isMissing(page: number): boolean {
    return (
      !this.cache.isFresh(page) &&
      !this.inflight.has(page) &&
      !this.retryTimers.has(page) &&
      !this.failed.has(page)
    );
  }

  private cancelRetry(page: number): void {
    clearTimeout(this.retryTimers.get(page));
    this.retryTimers.delete(page);
  }

  private wantedPages(): number[] {
    return this.range ? pagesForRange(this.range, this.target.count, this.pageSize) : [];
  }

  private newGeneration(): void {
    this.generation += 1;
    this.inflight.clear();
    this.eager = true;
    this.errorReported = false;
    clearTimeout(this.timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.attempts.clear();
    this.failed.clear();
    for (const page of [...this.waiters.keys()]) this.settle(page);
  }

  private request(pages: readonly number[]): void {
    const generation = this.generation;
    for (const page of pages) {
      if (this.cache.isFresh(page) || this.inflight.has(page)) continue;
      const promise = this.opts.fetchPage(page * this.pageSize, this.pageSize).then(
        (items) => {
          if (generation !== this.generation) return;
          this.inflight.delete(page);
          this.attempts.delete(page);
          // 件数より先にページが届くことがある (取り直しで件数が増えたとき) ので、ここでは
          // いまの件数で切り詰めない。範囲外は get が件数で隠し、件数が減れば sync が捨てる。
          this.cache.set(page, items, this.wantedPages());
          this.settle(page);
          this.opts.onChange();
          // 表示中のページが届いたら、その先読みを続ける。
          this.schedule();
        },
        (err) => {
          if (generation !== this.generation) return;
          this.inflight.delete(page);
          const failures = (this.attempts.get(page) ?? 0) + 1;
          this.attempts.set(page, failures);
          const delay = this.retryDelaysMs[failures - 1];
          if (delay !== undefined) {
            // 一時的な失敗 (DB のロックなど) は少し待って取り直す。
            this.retryTimers.set(
              page,
              setTimeout(() => {
                this.retryTimers.delete(page);
                if (generation === this.generation) this.request([page]);
              }, delay),
            );
            return;
          }
          // 再試行してもだめ: 失敗として覚え、表示側に案内を出させる。
          this.failed.add(page);
          this.settle(page);
          this.opts.onChange();
          if (this.errorReported) return;
          this.errorReported = true;
          this.opts.onError?.(err);
        },
      );
      this.inflight.set(page, promise);
    }
  }
}
