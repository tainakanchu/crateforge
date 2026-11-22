// ツールバーの畳み段階 (fitLevel) → 何をどう畳むか (#254)。
// 段階は Toolbar が「実際にはみ出したか」を測って 1 段ずつ上げる。ここは段階ごとの
// 見た目の決まりだけを持つ純関数 (tests/desktop/toolbarFold.test.ts で固定する)。
//   0: すべて表示
//   1: 表示切替・列ボタンをアイコンのみ、並び順は項目名だけ、検索範囲は短い表記
//   2: 並び順を方向矢印だけに
//   3: 取り込みをアイコンのみ (取り込みは小さな ▾ を残す)
//   4: 取り込みを ⋯ メニューへ (「取り込み」セクションが加わる。USB 書き出しは常に ⋯ の先頭)
//   5: 表示切替・並び順・列も ⋯ メニューへ
//   6: 検索範囲の切替も ⋯ メニューへ
// 主要な操作 (取り込み) のラベルは並び順のラベルより後まで残す
// (右ペインを開いた 1400px 前後の窓でもラベルを出すため)。
// 検索欄と右ペインの切替は畳まない。横スクロールはしない。

export const MAX_FIT_LEVEL = 6;

export interface ToolbarFold {
  /** 取り込み ▾ をアイコンのみにする。 */
  actionsIconOnly: boolean;
  /** 表示切替・列ボタンをアイコンのみにする (検索範囲も短い表記)。 */
  controlsIconOnly: boolean;
  /** 並び順ボタンの表記。 */
  sortLabel: "full" | "field" | "arrow";
  /** 取り込みを ⋯ に畳む。 */
  actionsInMenu: boolean;
  /** 表示切替・並び順・列を ⋯ に畳む。 */
  controlsInMenu: boolean;
  /** 検索範囲の切替を ⋯ に畳む。 */
  scopeInMenu: boolean;
}

export function toolbarFold(fitLevel: number): ToolbarFold {
  const level = Math.max(0, Math.min(MAX_FIT_LEVEL, Math.floor(fitLevel)));
  return {
    controlsIconOnly: level >= 1,
    sortLabel: level >= 2 ? "arrow" : level >= 1 ? "field" : "full",
    actionsIconOnly: level >= 3,
    actionsInMenu: level >= 4,
    controlsInMenu: level >= 5,
    scopeInMenu: level >= 6,
  };
}
