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
