import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PageCache,
  WindowLoader,
  clampRange,
  fetchTiming,
  isCursorKey,
  moveCursor,
  pageCount,
  pageOf,
  pagesForRange,
} from "../../src/lib/windowedList.ts";

// ---- ページ計算 ----

test("pageOf / pageCount: 通し番号とページの対応", () => {
  assert.equal(pageOf(0, 200), 0);
  assert.equal(pageOf(199, 200), 0);
  assert.equal(pageOf(200, 200), 1);
  assert.equal(pageOf(37081, 200), 185);
  assert.equal(pageCount(0, 200), 0);
  assert.equal(pageCount(1, 200), 1);
  assert.equal(pageCount(200, 200), 1);
  assert.equal(pageCount(201, 200), 2);
  assert.equal(pageCount(37082, 200), 186);
});

test("pagesForRange: 表示中のページ → 後ろの先読み → 前の先読みの順", () => {
  assert.deepEqual(pagesForRange({ start: 450, end: 620 }, 10_000, 200), [2, 3, 4, 1]);
  assert.deepEqual(pagesForRange({ start: 450, end: 620 }, 10_000, 200, 0), [2, 3]);
  assert.deepEqual(pagesForRange({ start: 450, end: 620 }, 10_000, 200, 2), [2, 3, 4, 5, 1, 0]);
});

test("pagesForRange: 先頭と末尾では件数の外のページを含めない", () => {
  assert.deepEqual(pagesForRange({ start: 0, end: 30 }, 10_000, 200), [0, 1]);
  // 37,082 件の最後のページは 185。一番下までスクロールしても 186 は取りに行かない。
  assert.deepEqual(pagesForRange({ start: 37_050, end: 37_081 }, 37_082, 200), [185, 184]);
  // 1 ページに収まる一覧は先読みなし。
  assert.deepEqual(pagesForRange({ start: 0, end: 30 }, 120, 200), [0]);
});

test("pagesForRange: 件数 0・空の範囲・件数を超えた範囲", () => {
  assert.deepEqual(pagesForRange({ start: 0, end: 30 }, 0, 200), []);
  assert.deepEqual(pagesForRange({ start: 10, end: 9 }, 1000, 200), []);
  // 件数が減った直後 (範囲が古い) は最後のページに丸める。
  assert.deepEqual(pagesForRange({ start: 900, end: 950 }, 250, 200), [1, 0]);
});

// ---- 取得タイミング ----

test("fetchTiming: 表示中のページが手元にあり、少ししか動いていなければすぐ取る (普通のスクロール)", () => {
  const known = new Set([3, 4]);
  assert.equal(fetchTiming([3], (p) => known.has(p), 0, 200), "now");
  assert.equal(fetchTiming([3, 4], (p) => known.has(p), 30, 200), "now");
  assert.equal(fetchTiming([3, 4], (p) => known.has(p), -49, 200), "now");
});

test("fetchTiming: 表示中のページが手元に無ければ止まるまで待つ (先読みを追い越した)", () => {
  const known = new Set([0, 1]);
  assert.equal(fetchTiming([90, 91], (p) => known.has(p), 0, 200), "settle");
  // 表示範囲の一部だけ手元にあるときも待つ。
  assert.equal(fetchTiming([1, 2], (p) => known.has(p), 10, 200), "settle");
  // 何も持っていないとき (呼び出し側が初回を eager にしない場合) も待つ。
  assert.equal(fetchTiming([0], () => false, 0, 200), "settle");
});

test("fetchTiming: 1 回で 1/4 ページ以上動いたら、手元にあるページの中でも待つ (スクロールバーのドラッグ)", () => {
  const known = new Set([3, 4]);
  assert.equal(fetchTiming([3, 4], (p) => known.has(p), 50, 200), "settle");
  assert.equal(fetchTiming([3], (p) => known.has(p), -5000, 200), "settle");
});

// ---- キャッシュ ----

test("PageCache: itemAt は通し番号で引ける。未取得は undefined", () => {
  const c = new PageCache<string>(3, 4);
  c.set(1, ["d", "e", "f"]);
  assert.equal(c.itemAt(3), "d");
  assert.equal(c.itemAt(5), "f");
  assert.equal(c.itemAt(0), undefined);
  assert.equal(c.itemAt(6), undefined);
  assert.equal(c.itemAt(-1), undefined);
});

test("PageCache: 上限を超えたら最も使っていないページから捨てる", () => {
  const c = new PageCache<number>(2, 3);
  c.set(0, [0, 1]);
  c.set(1, [2, 3]);
  c.set(2, [4, 5]);
  c.touch([0]); // 0 を使った → 最も使っていないのは 1
  c.set(3, [6, 7]);
  assert.deepEqual(c.pageNumbers().sort(), [0, 2, 3]);
  assert.equal(c.size, 3);
});

test("PageCache: 表示中 (keep) のページは上限を超えても捨てない", () => {
  const c = new PageCache<number>(2, 2);
  c.set(0, [0, 1], [0, 1, 2]);
  c.set(1, [2, 3], [0, 1, 2]);
  c.set(2, [4, 5], [0, 1, 2]);
  assert.deepEqual(c.pageNumbers().sort(), [0, 1, 2]);
  // 表示範囲が動けば、外れたページから捨てられる。
  c.set(3, [6, 7], [2, 3]);
  assert.deepEqual(c.pageNumbers().sort(), [2, 3]);
});

test("PageCache: invalidate は keep を古い内容のまま残し、ほかを捨てる", () => {
  const c = new PageCache<string>(2, 10);
  c.set(0, ["a", "b"]);
  c.set(1, ["c", "d"]);
  c.set(5, ["x", "y"]);
  c.invalidate([1, 2]);
  assert.deepEqual(c.pageNumbers(), [1]);
  assert.equal(c.has(1), true);
  assert.equal(c.isFresh(1), false, "取り直し待ち");
  assert.equal(c.itemAt(2), "c", "届くまでは古い内容を表示に使える");
  c.set(1, ["C", "D"]);
  assert.equal(c.isFresh(1), true);
  assert.equal(c.itemAt(2), "C");
});

test("PageCache: truncate は件数の外のページを捨て、最後のページのはみ出しを切る", () => {
  const c = new PageCache<number>(3, 10);
  c.set(0, [0, 1, 2]);
  c.set(1, [3, 4, 5]);
  c.set(2, [6, 7, 8]);
  c.truncate(5);
  assert.deepEqual(c.pageNumbers().sort(), [0, 1]);
  assert.equal(c.itemAt(4), 4);
  assert.equal(c.itemAt(5), undefined);
  c.truncate(0);
  assert.equal(c.size, 0);
});

test("PageCache: entries は通し番号の昇順 (LRU の順序に左右されない)", () => {
  const c = new PageCache<string>(2, 10);
  c.set(3, ["g", "h"]);
  c.set(0, ["a", "b"]);
  c.touch([3]);
  assert.deepEqual([...c.entries()], [
    [0, "a"],
    [1, "b"],
    [6, "g"],
    [7, "h"],
  ]);
});

// ---- 選択・カーソル ----

test("clampRange: 順不同の 2 点を件数に収める", () => {
  assert.deepEqual(clampRange(5, 2, 10), { start: 2, end: 5 });
  assert.deepEqual(clampRange(-3, 99, 10), { start: 0, end: 9 });
  assert.equal(clampRange(0, 0, 0), null);
  assert.equal(clampRange(20, 30, 10), null);
});

test("moveCursor: 上下・ページ・先頭・末尾", () => {
  assert.equal(moveCursor("ArrowDown", 5, 100, 20), 6);
  assert.equal(moveCursor("ArrowUp", 5, 100, 20), 4);
  assert.equal(moveCursor("PageDown", 5, 100, 20), 25);
  assert.equal(moveCursor("PageUp", 25, 100, 20), 5);
  assert.equal(moveCursor("Home", 50, 100, 20), 0);
  assert.equal(moveCursor("End", 50, 37_082, 20), 37_081);
});

test("moveCursor: 端で止まる。カーソルなしは下方向が先頭・上方向が末尾から", () => {
  assert.equal(moveCursor("ArrowUp", 0, 100, 20), 0);
  assert.equal(moveCursor("ArrowDown", 99, 100, 20), 99);
  assert.equal(moveCursor("PageDown", 95, 100, 20), 99);
  assert.equal(moveCursor("PageUp", 3, 100, 20), 0);
  assert.equal(moveCursor("ArrowDown", null, 100, 20), 0);
  assert.equal(moveCursor("PageDown", null, 100, 20), 0);
  assert.equal(moveCursor("ArrowUp", null, 100, 20), 99);
  assert.equal(moveCursor("End", null, 0, 20), null);
  // 1 画面の行数が取れていなくても 1 行は動く。
  assert.equal(moveCursor("PageDown", 5, 100, 0), 6);
});

test("isCursorKey", () => {
  assert.equal(isCursorKey("Home"), true);
  assert.equal(isCursorKey("PageDown"), true);
  assert.equal(isCursorKey("Enter"), false);
});

// ---- WindowLoader (世代・重複排除・スクロール停止待ち) ----

/** 取得の呼び出しを記録し、テストから 1 件ずつ応答できる偽のデータ源。 */
function fakeSource(total: number) {
  const calls: { offset: number; limit: number; resolve: () => void; reject: (e: unknown) => void }[] = [];
  let label = "";
  const fetchPage = (offset: number, limit: number) =>
    new Promise<string[]>((resolve, reject) => {
      const tag = label;
      calls.push({
        offset,
        limit,
        resolve: () =>
          resolve(
            Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => `${tag}${offset + i}`),
          ),
        reject,
      });
    });
  return {
    calls,
    fetchPage,
    /** これ以降に始まった取得の応答に付ける印 (取り直し後の内容を見分ける)。 */
    setLabel: (l: string) => {
      label = l;
    },
    offsets: () => calls.map((c) => c.offset),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeLoader(total: number, settleMs = 15) {
  const src = fakeSource(total);
  let changes = 0;
  const errors: unknown[] = [];
  const loader = new WindowLoader<string>({
    fetchPage: src.fetchPage,
    onChange: () => {
      changes += 1;
    },
    onError: (e) => errors.push(e),
    pageSize: 10,
    maxPages: 4,
    settleMs,
    retryDelaysMs: [5, 10],
  });
  return { loader, src, errors, changes: () => changes };
}

test("WindowLoader: 最初の表示範囲はすぐ取り、届くまで undefined (プレースホルダ)", async () => {
  const { loader, src, changes } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.schedule();
  assert.deepEqual(src.offsets(), [], "範囲が伝わるまで取得しない");
  loader.setVisibleRange(0, 7);
  assert.deepEqual(src.offsets(), [0, 10], "表示中のページ + 先読み");
  assert.equal(loader.get(3), undefined);
  src.calls[0].resolve();
  await flush();
  assert.equal(loader.get(3), "3");
  assert.equal(loader.get(12), undefined);
  assert.equal(changes(), 1);
});

test("WindowLoader: 件数が 0 のあいだは取得しない。確定したら schedule で取り始める", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 0 });
  loader.setVisibleRange(0, 7);
  loader.schedule();
  assert.deepEqual(src.offsets(), []);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.schedule();
  assert.deepEqual(src.offsets(), [0, 10]);
});

test("WindowLoader: 同じページを二重に取らない", () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  loader.setVisibleRange(1, 8);
  loader.setVisibleRange(2, 9);
  loader.schedule();
  assert.deepEqual(src.offsets(), [0, 10]);
});

test("WindowLoader: スクロールバーを速く引いても通過したページを取らない", async () => {
  const { loader, src } = makeLoader(10_000, 15);
  loader.sync({ key: "a", revision: 0, count: 10_000 });
  loader.setVisibleRange(0, 7);
  for (const c of src.calls) c.resolve();
  await flush();
  src.calls.length = 0;
  // 先読みを追い越す速さで通過する (隣のページへ 1 つずつ進む場合も含む。
  // 各イベントの間隔は停止待ちより短い)。
  for (const start of [25, 35, 45, 1000, 2500, 4000, 6000, 9000]) {
    loader.setVisibleRange(start, start + 7);
    await wait(2);
  }
  assert.deepEqual(src.offsets(), [], "止まるまで取得しない");
  await wait(40);
  assert.deepEqual(src.offsets(), [9000, 9010, 8990], "止まった位置だけを取る");
});

test("WindowLoader: 普通のスクロール (表示中のページは手元にある) は先読みを待たずに取る", async () => {
  const { loader, src } = makeLoader(10_000, 1000);
  loader.sync({ key: "a", revision: 0, count: 10_000 });
  loader.setVisibleRange(0, 7);
  for (const c of src.calls) c.resolve();
  await flush();
  src.calls.length = 0;
  loader.setVisibleRange(2, 9);
  assert.deepEqual(src.offsets(), [], "ページ 0 の中 (ページ 1 は先読み済み)");
  loader.setVisibleRange(4, 11); // ページ 1 に入る → 先読みのページ 2 が足りない
  assert.deepEqual(src.offsets(), [20]);
});

test("WindowLoader: key が変わったら古い応答を捨て、キャッシュも捨てる", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  const stale = src.calls[0];
  src.setLabel("b:");
  loader.sync({ key: "b", revision: 0, count: 1000 });
  assert.equal(loader.get(0), undefined);
  loader.schedule();
  stale.resolve(); // 前の一覧の応答が後から届く
  await flush();
  assert.equal(loader.get(0), undefined, "古い世代の応答は使わない");
  src.calls.find((c) => c.offset === 0 && c !== stale)!.resolve();
  await flush();
  assert.equal(loader.get(0), "b:0");
});

test("WindowLoader: key が変わったら表示範囲は先頭に戻る (範囲を伝え直さなくても先頭のページを取る)", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(500, 507);
  for (const c of src.calls) c.resolve();
  await flush();
  src.calls.length = 0;
  loader.sync({ key: "b", revision: 0, count: 1000 });
  loader.schedule();
  assert.deepEqual(src.offsets(), [0, 10], "前の一覧の位置 (500) ではなく先頭を取る");
  // 先頭にいたまま切り替わると、ビューから見た表示範囲は変わらない。それでも取り直せる。
  for (const c of src.calls) c.resolve();
  await flush();
  src.calls.length = 0;
  loader.sync({ key: "c", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  loader.schedule();
  assert.deepEqual(src.offsets(), [0, 10]);
});

test("WindowLoader: revision が変わったら表示中のページを取り直す。届くまで古い内容を表示する", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(20, 27);
  for (const c of src.calls) c.resolve();
  await flush();
  assert.equal(loader.get(20), "20");
  src.calls.length = 0;

  src.setLabel("new:");
  loader.sync({ key: "a", revision: 1, count: 1000 });
  loader.schedule();
  assert.deepEqual(src.offsets(), [20, 30, 10], "表示範囲のページを待たずに取り直す");
  assert.equal(loader.get(20), "20", "届くまでプレースホルダに戻さない");
  src.calls[0].resolve();
  await flush();
  assert.equal(loader.get(20), "new:20");
});

test("WindowLoader: revision が変わる前に始めた取得の応答は捨てる", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  const old = src.calls[0];
  src.setLabel("new:");
  loader.sync({ key: "a", revision: 1, count: 1000 });
  loader.schedule();
  const fresh = src.calls.filter((c) => c.offset === 0)[1];
  fresh.resolve();
  await flush();
  old.resolve(); // 古い応答が新しい応答の後に届く
  await flush();
  assert.equal(loader.get(0), "new:0");
});

test("WindowLoader: 件数が減ったら範囲外の項目を返さない", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  for (const c of src.calls) c.resolve();
  await flush();
  assert.equal(loader.get(15), "15");
  loader.sync({ key: "a", revision: 0, count: 12 });
  assert.equal(loader.get(11), "11");
  assert.equal(loader.get(15), undefined);
});

test("WindowLoader: キャッシュは上限までしか持たない (表示中のページは残す)", async () => {
  const { loader, src } = makeLoader(10_000, 0);
  loader.sync({ key: "a", revision: 0, count: 10_000 });
  for (let start = 0; start < 200; start += 10) {
    loader.setVisibleRange(start, start + 7);
    await flush();
    for (const c of src.calls) c.resolve();
    await flush();
  }
  const loaded = [...loader.loaded()].map(([i]) => i);
  assert.ok(loaded.length <= 4 * 10, `持ちすぎ: ${loaded.length}`);
  assert.equal(loader.get(195), "195", "表示中のページは残っている");
  assert.equal(loader.get(0), undefined, "古いページは捨てられている");
});

test("WindowLoader: ensure は未取得のページを取って返す。一覧が切り替わったら undefined", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  const p = loader.ensure(505);
  assert.deepEqual(src.offsets(), [500]);
  src.calls[0].resolve();
  assert.equal(await p, "505");
  assert.equal(await loader.ensure(5000), undefined, "件数の外");

  const q = loader.ensure(700);
  loader.sync({ key: "b", revision: 0, count: 1000 });
  src.calls[1].resolve();
  assert.equal(await q, undefined);
});

test("WindowLoader: 取得に失敗したら少し待って自動で取り直す (一時的な失敗は見せない)", async () => {
  const { loader, src, errors } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  src.calls[0].reject(new Error("locked"));
  src.calls[1].resolve();
  await flush();
  assert.equal(loader.hasFailedVisible(), false, "再試行中は失敗として見せない");
  await wait(20);
  const retry = src.calls.filter((c) => c.offset === 0);
  assert.equal(retry.length, 2, "1 回目の再試行");
  retry[1].resolve();
  await flush();
  assert.equal(loader.get(0), "0");
  assert.equal(errors.length, 0);
  assert.equal(loader.hasFailedVisible(), false);
});

test("WindowLoader: 再試行しても取れないページは失敗として覚え、勝手には取り直さない", async () => {
  const { loader, src, errors, changes } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  src.calls[1].resolve(); // 先読みのページ 1 は取れる
  // ページ 0 は 3 回 (最初 + 再試行 2 回) とも失敗する。
  for (let i = 0; i < 3; i++) {
    const pending = src.calls.filter((c) => c.offset === 0);
    assert.equal(pending.length, i + 1);
    pending[i].reject(new Error("boom"));
    await wait(25);
  }
  assert.equal(src.calls.filter((c) => c.offset === 0).length, 3, "再試行は 2 回まで");
  assert.equal(errors.length, 1, "失敗は 1 回だけ知らせる");
  assert.equal(loader.hasFailedVisible(), true);
  assert.equal(loader.get(0), undefined);
  // スクロールで戻ってきても、自動では取り直さない (失敗し続けるページを叩き続けない)。
  const before = changes();
  loader.setVisibleRange(1, 8);
  loader.schedule();
  await wait(30);
  assert.equal(src.calls.filter((c) => c.offset === 0).length, 3);

  // 利用者が再試行したら取り直す。
  loader.retryFailed();
  assert.ok(changes() > before, "案内を消すために再描画させる");
  const again = src.calls.filter((c) => c.offset === 0);
  assert.equal(again.length, 4);
  again[3].resolve();
  await flush();
  assert.equal(loader.get(0), "0");
  assert.equal(loader.hasFailedVisible(), false);
});

test("WindowLoader: 失敗の記録は一覧の切り替え・取り直しで消える", async () => {
  const { loader, src } = makeLoader(1000, 15);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  for (let i = 0; i < 3; i++) {
    src.calls.filter((c) => c.offset === 0)[i].reject(new Error("boom"));
    await wait(25);
  }
  assert.equal(loader.hasFailedVisible(), true);
  loader.sync({ key: "a", revision: 1, count: 1000 });
  assert.equal(loader.hasFailedVisible(), false);
  loader.schedule();
  assert.equal(src.calls.filter((c) => c.offset === 0).length, 4, "取り直しでは取りに行く");
});

test("WindowLoader: 件数より先にページが届いても、増えたぶんの末尾が未取得のまま残らない", async () => {
  // 250 件 → 260 件に増えた取り直し。ページ (新しい内容で 60 件) が、件数の更新より先に届く。
  const src = fakeSource(260);
  const loader = new WindowLoader<string>({
    fetchPage: src.fetchPage,
    onChange: () => {},
    pageSize: 200,
  });
  loader.sync({ key: "a", revision: 0, count: 250 });
  loader.setVisibleRange(210, 249);
  for (const c of src.calls) c.resolve();
  await flush();
  src.calls.length = 0;

  loader.sync({ key: "a", revision: 1, count: 250 }); // 件数はまだ古い
  loader.schedule();
  for (const c of src.calls) c.resolve(); // ページが先に届く
  await flush();
  assert.equal(loader.get(249), "249");
  assert.equal(loader.get(255), undefined, "件数が確定するまでは範囲外");
  src.calls.length = 0;
  loader.sync({ key: "a", revision: 1, count: 260 }); // あとから件数が届く
  loader.schedule();
  assert.equal(loader.get(255), "255", "届いていたページの続きがそのまま見える");
  assert.equal(loader.get(259), "259");
  assert.deepEqual(src.offsets(), [], "取り直しも要らない");
});

test("WindowLoader: 件数だけが増えたら、短い最後のページを取り直す", async () => {
  let total = 250;
  const calls: number[] = [];
  const loader = new WindowLoader<string>({
    fetchPage: async (offset, limit) => {
      calls.push(offset);
      return Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => `${offset + i}`);
    },
    onChange: () => {},
    pageSize: 200,
  });
  loader.sync({ key: "a", revision: 0, count: 250 });
  loader.setVisibleRange(210, 249);
  await flush();
  assert.equal(loader.get(249), "249");
  calls.length = 0;
  total = 260;
  loader.sync({ key: "a", revision: 0, count: 260 });
  loader.schedule();
  assert.deepEqual(calls, [200], "50 件しか持っていないページ 1 を取り直す");
  assert.equal(loader.get(249), "249", "届くまでは古い内容を表示する");
  await flush();
  assert.equal(loader.get(259), "259");
});

test("WindowLoader: stop のあとに届いた応答は捨てる", async () => {
  const { loader, src, changes } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  loader.stop();
  src.calls[0].resolve();
  await flush();
  assert.equal(changes(), 0);
  assert.equal(loader.get(0), undefined);
  // 張り直し (StrictMode) では取得し直す。
  src.calls.length = 0;
  loader.schedule();
  assert.deepEqual(src.offsets(), [0, 10]);
});

test("WindowLoader: 並び順だけの変更 (同じ group) では先頭を空白にせず、届いたら入れ替える", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a:name", group: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(0, 7);
  for (const c of src.calls) c.resolve();
  await flush();
  src.calls.length = 0;

  src.setLabel("bpm:");
  loader.sync({ key: "a:bpm", group: "a", revision: 0, count: 1000 });
  loader.schedule();
  assert.equal(loader.get(0), "0", "新しい並びが届くまで古い行を表示する");
  assert.deepEqual(src.offsets(), [0, 10], "先頭のページを待たずに取り直す");
  src.calls[0].resolve();
  await flush();
  assert.equal(loader.get(0), "bpm:0");

  // group が違えば (スコープ・検索の変更) 前の一覧の行は見せない。
  loader.sync({ key: "b:bpm", group: "b", revision: 0, count: 1000 });
  assert.equal(loader.get(0), undefined);
});

test("WindowLoader: 並び順の変更では、先頭以外の古いページを残さない", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a:name", group: "a", revision: 0, count: 1000 });
  loader.setVisibleRange(500, 507);
  for (const c of src.calls) c.resolve();
  await flush();
  loader.sync({ key: "a:bpm", group: "a", revision: 0, count: 1000 });
  assert.equal(loader.get(500), undefined);
});

test("WindowLoader.remap: 持っているページを新しい並びにし、取得中の古い応答は捨てる", async () => {
  const { loader, src, changes } = makeLoader(30);
  loader.sync({ key: "a", revision: 0, count: 30 });
  loader.setVisibleRange(0, 7);
  src.calls[0].resolve(); // ページ 0 だけ届く。ページ 1 (先読み) は取得中のまま
  await flush();
  const pending = src.calls[1];
  const before = changes();
  // 0 と 1 を入れ替えた並び。
  const order = ["1", "0", "2", "3", "4", "5", "6", "7", "8", "9"];
  loader.remap((i) => order[i]);
  assert.equal(loader.get(0), "1");
  assert.equal(loader.get(1), "0");
  assert.equal(loader.get(9), "9");
  assert.ok(changes() > before);
  pending.resolve(); // 並べ替え前に始めた取得の応答
  await flush();
  assert.equal(loader.get(10), undefined, "古い並びの応答は使わない");
  // 取り直しは走っている。
  assert.equal(src.calls.filter((c) => c.offset === 10).length, 2);
});

test("PageCache.remap: 新しい並びで埋められないページは捨てる", () => {
  const c = new PageCache<string>(2, 10);
  c.set(0, ["a", "b"]);
  c.set(1, ["c", "d"]);
  const order = ["b", "a", "c", undefined];
  c.remap((i) => order[i]);
  assert.equal(c.itemAt(0), "b");
  assert.equal(c.itemAt(1), "a");
  assert.equal(c.has(1), false);
});

test("WindowLoader.ensure: 最初の失敗では返さず、自動の再試行の結果まで待つ", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  const p = loader.ensure(505);
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  src.calls[0].reject(new Error("locked"));
  await flush();
  assert.equal(settled, false, "再試行を待っている");
  await wait(20);
  const retry = src.calls.filter((c) => c.offset === 500);
  assert.equal(retry.length, 2);
  retry[1].resolve();
  assert.equal(await p, "505");
});

test("WindowLoader.ensure: 再試行しても取れなければ undefined。一覧が切り替わっても待ち続けない", async () => {
  const { loader, src } = makeLoader(1000);
  loader.sync({ key: "a", revision: 0, count: 1000 });
  const p = loader.ensure(505);
  for (let i = 0; i < 3; i++) {
    src.calls.filter((c) => c.offset === 500)[i].reject(new Error("boom"));
    await wait(25);
  }
  assert.equal(await p, undefined);

  const q = loader.ensure(700);
  loader.sync({ key: "b", revision: 0, count: 1000 });
  assert.equal(await q, undefined);
});
