import { test } from "vitest";
import assert from "node:assert/strict";
import {
  TIP_GAP,
  TIP_MARGIN,
  intersectRect,
  placeInfoTip,
} from "../../src/components/infoTipPosition.ts";

const bounds = { top: 100, left: 100, width: 600, height: 400 }; // 100..700 x 100..500
const tip = { width: 200, height: 80 };
const btn = (top: number, left: number) => ({ top, left, width: 18, height: 18 });

test("既定はボタンの下・左端そろえ", () => {
  const p = placeInfoTip(btn(150, 200), tip, bounds);
  assert.equal(p.placement, "below");
  assert.equal(p.top, 150 + 18 + TIP_GAP);
  assert.equal(p.left, 200);
});

test("下に収まらず上の方が広ければ上に反転する", () => {
  const p = placeInfoTip(btn(450, 200), tip, bounds);
  assert.equal(p.placement, "above");
  assert.equal(p.top, 450 - TIP_GAP - 80);
});

test("右端からはみ出さないよう左に寄せる", () => {
  const p = placeInfoTip(btn(150, 650), tip, bounds);
  assert.equal(p.left, 700 - TIP_MARGIN - 200);
});

test("左端より左には出さない", () => {
  const p = placeInfoTip(btn(150, 90), tip, bounds);
  assert.equal(p.left, 100 + TIP_MARGIN);
});

test("上下どちらにも収まらないときは境界内に押し込む", () => {
  const small = { top: 0, left: 0, width: 600, height: 120 };
  const p = placeInfoTip(btn(50, 10), { width: 200, height: 200 }, small);
  assert.equal(p.top, TIP_MARGIN);
});

test("intersectRect はダイアログ枠とビューポートの共通部分を返す", () => {
  const r = intersectRect(
    { top: -20, left: 50, width: 800, height: 900 },
    { top: 0, left: 0, width: 640, height: 480 },
  );
  assert.deepEqual(r, { top: 0, left: 50, width: 590, height: 480 });
});

test("下にちょうど収まるなら、上の方が広くても下に出す", () => {
  // 境界 100..500 (内側 108..492)。ボタン下端 + 間隔 = 324、下の余白は 168。上は 186。
  const p = placeInfoTip(btn(300, 200), { width: 200, height: 168 }, bounds);
  assert.equal(p.placement, "below");
  assert.equal(p.top, 300 + 18 + TIP_GAP);
});

test("下に収まらなくても、上の方が狭ければ下のまま境界内に押し上げる", () => {
  // 内側 344..542。下の余白 88・上の余白 80 (間隔ぶんを引いた広さで比べる)。
  const b = { top: 336, left: 100, width: 600, height: 214 };
  const p = placeInfoTip(btn(430, 200), { width: 200, height: 100 }, b);
  assert.equal(p.placement, "below");
  assert.equal(p.top, 336 + 214 - TIP_MARGIN - 100);
});

test("上下の余白が同じなら下に出す", () => {
  // 内側 336..542。下の余白 88・上の余白 88。
  const b = { top: 328, left: 100, width: 600, height: 222 };
  const p = placeInfoTip(btn(430, 200), { width: 200, height: 100 }, b);
  assert.equal(p.placement, "below");
});

test("intersectRect: 重ならない・辺が接するだけのときは b を返す", () => {
  const b = { top: 0, left: 0, width: 640, height: 480 };
  // 横に離れている (縦は重なる)
  assert.equal(intersectRect({ top: 10, left: 700, width: 50, height: 50 }, b), b);
  // 縦に離れている (横は重なる)
  assert.equal(intersectRect({ top: 500, left: 10, width: 50, height: 50 }, b), b);
  // 右辺・下辺で接するだけ
  assert.equal(intersectRect({ top: 10, left: 640, width: 50, height: 50 }, b), b);
  assert.equal(intersectRect({ top: 480, left: 10, width: 50, height: 50 }, b), b);
});

test("intersectRect: 共通部分の高さは上端からの差", () => {
  assert.deepEqual(
    intersectRect(
      { top: 50, left: 20, width: 100, height: 100 },
      { top: 30, left: 0, width: 640, height: 480 },
    ),
    { top: 50, left: 20, width: 100, height: 100 },
  );
});
