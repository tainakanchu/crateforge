// カードグリッド (AlbumsView / ArtistsView / TracksView) の行モデルと寸法計算。
// React / DOM に依存しない純関数だけを置く (tests/desktop/gridRows.test.ts で固定)。

export const GRID_GAP = 18;
export const GRID_PAD_X = 20;
export const GRID_MIN_CARD = 150;
/** カード下のラベル 2 行 (名前・件数) のおよその高さ。 */
export const GRID_META_H = 46;
/** 展開行の高さの見積もり (実測されるまでの仮の値)。 */
export const GRID_EXPAND_ESTIMATE = 260;
/** 末尾からこの距離までスクロールしたら追加ロードする。 */
export const GRID_LOAD_MORE_PX = 400;

export interface GridMetrics {
  /** 1 行あたりのカード数 (下限 2)。 */
  cols: number;
  /** カード 1 枚の幅 (px)。 */
  cardW: number;
}

/** スクロール要素の内容幅から列数とカード幅を決める。幅が未計測 (0) のときは 2 列。 */
export function gridMetrics(width: number): GridMetrics {
  const inner = Math.max(0, width - GRID_PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GRID_GAP) / (GRID_MIN_CARD + GRID_GAP)) || 2);
  const cardW = Math.max(
    60,
    inner > 0 ? (inner - GRID_GAP * (cols - 1)) / cols : GRID_MIN_CARD,
  );
  return { cols, cardW };
}

export type GridRow<T> =
  | { type: "grid"; key: string; items: T[] }
  | { type: "expand"; key: string; item: T };

/**
 * items を cols 枚ずつのグリッド行に分け、expandedKey の項目を含む行の直後に展開行を差し込む。
 *
 * 行キーは仮想化の実測サイズのキャッシュキーになるので、展開の開閉で変わってはいけない
 * (行番号をキーにすると、展開行の挿入/除去で後続行の番号がずれ、実測サイズが別の行に
 * 付け替わって行が重なる)。
 * - グリッド行: `g:<cols>:<グリッド行の通し番号>` (展開行を数えない番号。同じ曲が複数回入る
 *   プレイリストでも一意)
 * - 展開行: `x:<項目キー>`
 */
export function buildGridRows<T>(
  items: readonly T[],
  cols: number,
  keyOf: (item: T) => string,
  expandedKey: string | null = null,
): GridRow<T>[] {
  const n = Math.max(1, Math.floor(cols));
  const out: GridRow<T>[] = [];
  for (let i = 0; i < items.length; i += n) {
    const chunk = items.slice(i, i + n);
    out.push({ type: "grid", key: `g:${n}:${i / n}`, items: chunk });
    if (expandedKey === null) continue;
    for (const it of chunk) {
      const k = keyOf(it);
      if (k === expandedKey) out.push({ type: "expand", key: `x:${k}`, item: it });
    }
  }
  return out;
}

/** スクロール位置が末尾の手前 threshold px 以内か (追加ロードの判定)。 */
export function isNearBottom(
  el: { scrollTop: number; clientHeight: number; scrollHeight: number },
  threshold: number = GRID_LOAD_MORE_PX,
): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
}
