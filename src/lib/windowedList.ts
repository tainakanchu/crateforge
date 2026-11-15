// 一覧のウィンドウ取得 (件数ぶんのスクロール範囲 + 見えているページだけ取得) の純粋な部分。
// React / DOM / Tauri に依存しない (tests/desktop/windowedList.test.ts で固定)。
// 仕様は docs/library-list/design.md §1–2。配線は hooks/useWindowedList.ts。

/** 1 ページの件数。 */
export const WINDOW_PAGE_SIZE = 200;
/** キャッシュに残すページ数の上限 (表示中のページはこれを超えても捨てない)。 */
export const WINDOW_MAX_PAGES = 20;
/** 表示範囲の前後に先読みするページ数。 */
export const WINDOW_PREFETCH_PAGES = 1;
/** 離れた位置へ跳んだとき、取得を始めるまでスクロールの停止を待つ時間 (ms)。 */
export const WINDOW_SETTLE_MS = 100;
/** 「すぐ取る」ときに同時に走らせてよい取得の数。 */
export const WINDOW_MAX_EAGER_FETCHES = 2;

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
 * 足りないページのどれかが「手元にある (キャッシュ済み・取得中) ページの隣」で、取得中が
 * maxEager 件未満なら、表示が連続して動いている (普通のスクロール) とみなしてすぐ取る。
 * それ以外は離れた位置へのジャンプ (スクロールバーを引いている) なので、止まるまで待つ。
 * こうすると、スクロールバーを速く引いても通過したページを 1 つずつ取りに行かない。
 */
export function fetchTiming(
  missing: readonly number[],
  isKnown: (page: number) => boolean,
  inflightCount: number,
  maxEager: number = WINDOW_MAX_EAGER_FETCHES,
): FetchTiming {
  if (inflightCount >= maxEager) return "settle";
  return missing.some((p) => isKnown(p - 1) || isKnown(p + 1)) ? "now" : "settle";
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
  /** ページの取得に失敗したとき (世代ごとに 1 回)。 */
  onError?: (err: unknown) => void;
  pageSize?: number;
  maxPages?: number;
  settleMs?: number;
}

/** 一覧の同一性 (key)・取り直しの合図 (revision)・全件数 (count)。 */
export interface WindowTarget {
  key: string;
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

  constructor(opts: WindowLoaderOptions<T>) {
    this.opts = opts;
    this.pageSize = opts.pageSize ?? WINDOW_PAGE_SIZE;
    this.settleMs = opts.settleMs ?? WINDOW_SETTLE_MS;
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
      this.started = true;
      this.newGeneration();
      this.cache.clear();
      this.range = null;
    } else if (!Object.is(this.target.revision, next.revision)) {
      this.newGeneration();
      this.cache.invalidate(this.wantedPages());
    }
    if (this.target.count !== next.count) this.cache.truncate(next.count);
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
    this.range = { start, end };
    this.schedule();
  }

  /** 表示範囲に足りないページを、すぐ / スクロールが止まってから取得する。 */
  schedule(): void {
    const wanted = this.wantedPages();
    this.cache.touch(wanted);
    const missing = wanted.filter((p) => !this.cache.isFresh(p) && !this.inflight.has(p));
    if (missing.length === 0) return;
    const timing = this.eager
      ? "now"
      : fetchTiming(
          missing,
          (p) => this.cache.has(p) || this.inflight.has(p),
          this.inflight.size,
        );
    clearTimeout(this.timer);
    if (timing === "now") {
      this.eager = false;
      this.request(missing);
      return;
    }
    // 待っているあいだに範囲が動くので、止まった時点で見えている範囲を取る。
    this.timer = setTimeout(() => this.request(this.wantedPages()), this.settleMs);
  }

  /** index の項目を (未取得なら取得して) 返す。待つあいだに一覧が切り替わったら undefined。 */
  async ensure(index: number): Promise<T | undefined> {
    if (index < 0 || index >= this.target.count) return undefined;
    const generation = this.generation;
    const page = pageOf(index, this.pageSize);
    if (!this.cache.isFresh(page)) {
      this.request([page]);
      await this.inflight.get(page);
      if (generation !== this.generation) return undefined;
    }
    return this.cache.itemAt(index);
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
  }

  private request(pages: readonly number[]): void {
    const generation = this.generation;
    for (const page of pages) {
      if (this.cache.isFresh(page) || this.inflight.has(page)) continue;
      const promise = this.opts.fetchPage(page * this.pageSize, this.pageSize).then(
        (items) => {
          if (generation !== this.generation) return;
          this.inflight.delete(page);
          this.cache.set(page, items, this.wantedPages());
          this.cache.truncate(this.target.count);
          this.opts.onChange();
        },
        (err) => {
          if (generation !== this.generation) return;
          this.inflight.delete(page);
          if (this.errorReported) return;
          this.errorReported = true;
          this.opts.onError?.(err);
        },
      );
      this.inflight.set(page, promise);
    }
  }
}
