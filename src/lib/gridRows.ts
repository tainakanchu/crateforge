// カードグリッド (AlbumsView / ArtistsView / TracksView) の行モデルと寸法計算。
// React / DOM に依存しない純関数だけを置く (tests/desktop/gridRows.test.ts で固定)。

export const GRID_GAP = 18;
export const GRID_PAD_X = 20;
export const GRID_MIN_CARD = 150;
/** カード下のラベル 2 行 (名前・件数) の高さ。styles.css の .cov-meta (7 + 18 + 1 + 16) と一致させる。 */
export const GRID_META_H = 42;
/** 展開行の高さの見積もり (実測されるまでの仮の値)。 */
export const GRID_EXPAND_ESTIMATE = 260;

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

/** カード行: 通し番号 [start, end) の項目を横に並べる。 */
export interface GridCardRow {
  type: "grid";
  key: string;
  start: number;
  end: number;
}
/** 展開行: 通し番号 itemIndex の項目の中身 (アルバムの曲一覧など)。 */
export interface GridExpandRow {
  type: "expand";
  key: string;
  itemIndex: number;
}
export type GridRow = GridCardRow | GridExpandRow;

/** 展開中の項目。項目キーと、開いたときの通し番号で覚える。 */
export interface GridExpanded {
  key: string;
  index: number;
}

export interface GridLayout {
  cols: number;
  /** 仮想化する行数 (カード行 + 展開行)。 */
  rowCount: number;
  /** 仮想行 i の内容。 */
  rowAt: (i: number) => GridRow;
  /** 仮想行 [firstRow, lastRow] に並ぶ項目の通し番号の範囲 (両端を含む)。項目が無ければ null。 */
  itemRange: (firstRow: number, lastRow: number) => { start: number; end: number } | null;
}

/**
 * count 件の項目を cols 枚ずつのカード行に並べ、展開中の項目を含む行の直後に展開行を 1 つ差し込む。
 *
 * 行は件数だけで決まる (項目の中身は要らない) ので、スクロール範囲を最初から全件ぶん確保でき、
 * 未取得の項目はプレースホルダのカードで埋められる (docs/library-list/design.md §1, §6)。
 *
 * 行キーは仮想化の実測サイズのキャッシュキーになるので、展開の開閉で変わってはいけない
 * (行番号をキーにすると、展開行の挿入/除去で後続行の番号がずれ、実測サイズが別の行に
 * 付け替わって行が重なる)。
 * - カード行: `g:<cols>:<カード行の通し番号>` (展開行を数えない番号)
 * - 展開行: `x:<項目キー>`
 */
export function gridLayout(
  count: number,
  cols: number,
  expanded: GridExpanded | null = null,
): GridLayout {
  const n = Math.max(1, Math.floor(cols));
  const total = Math.max(0, Math.floor(count));
  const cardRows = Math.ceil(total / n);
  const open = expanded !== null && expanded.index >= 0 && expanded.index < total ? expanded : null;
  /** 展開行の仮想行番号 (無ければ -1)。 */
  const expandRow = open ? Math.floor(open.index / n) + 1 : -1;
  const rowCount = cardRows + (open ? 1 : 0);
  /** 仮想行 i に対応するカード行の番号 (展開行は、その項目が載っている直前のカード行)。 */
  const cardRowOf = (i: number) => (expandRow >= 0 && i >= expandRow ? i - 1 : i);
  return {
    cols: n,
    rowCount,
    rowAt: (i) => {
      if (open && i === expandRow) {
        return { type: "expand", key: `x:${open.key}`, itemIndex: open.index };
      }
      const g = cardRowOf(i);
      return { type: "grid", key: `g:${n}:${g}`, start: g * n, end: Math.min(total, (g + 1) * n) };
    },
    itemRange: (firstRow, lastRow) => {
      if (rowCount === 0 || lastRow < firstRow) return null;
      const clamp = (i: number) => Math.max(0, Math.min(rowCount - 1, i));
      const first = cardRowOf(clamp(firstRow));
      const last = cardRowOf(clamp(lastRow));
      return { start: first * n, end: Math.min(total, (last + 1) * n) - 1 };
    },
  };
}

/**
 * 一覧を取り直したあと、展開中の項目の位置を合わせ直す。
 *
 * - 元の位置の項目が同じキーなら、そのまま。
 * - 元の位置がまだ取得できていなければ、そのまま (届いてから判定し直す)。
 * - 別の項目になっていた / 件数が減って位置が無くなったら、取得済みの項目から同じキーを探して
 *   移す。見つからなければ閉じる (null)。
 */
export function relocateExpanded(
  expanded: GridExpanded | null,
  count: number,
  keyAt: (index: number) => string | undefined,
  loadedKeys: Iterable<[number, string]>,
): GridExpanded | null {
  if (expanded === null) return null;
  if (expanded.index < count) {
    const here = keyAt(expanded.index);
    if (here === undefined || here === expanded.key) return expanded;
  }
  for (const [index, key] of loadedKeys) {
    if (key === expanded.key) return { key, index };
  }
  return null;
}

/** 行の高さを左右する寸法。これが変わったときだけ実測キャッシュを捨てる。 */
export interface GridMeasureKey {
  /** グリッド行 1 行の高さの見積もり (カード幅・ラベル行数で決まる)。 */
  gridRowHeight: number;
  cols: number;
}

/**
 * 仮想化の実測キャッシュを捨てて測り直すべきか。
 *
 * 引数に行の並びや展開状態を取らないのは意図どおり: 展開の開閉・遅延取得・ページの到着で
 * キャッシュを捨てると、展開行が見積もり高さに戻って次の行が重なる (行キーが安定なので不要)。
 * 測り直すのは初回 (prev が null) と、カード幅/列数が変わってグリッド行の高さが変わるときだけ。
 */
export function shouldRemeasureGrid(prev: GridMeasureKey | null, next: GridMeasureKey): boolean {
  return prev === null || prev.gridRowHeight !== next.gridRowHeight || prev.cols !== next.cols;
}

/** remeasureGridRows が使う仮想化の操作 (@tanstack/virtual-core の Virtualizer の一部)。 */
export interface GridRemeasurer {
  measure(): void;
  getTotalSize(): number;
  resizeItem(index: number, size: number): void;
}

/**
 * 実測キャッシュを捨て、表示中の行の実測サイズを入れ直す (列数/カード幅が変わったとき)。
 *
 * virtual-core の `measure()` はキャッシュを消すだけで、位置の配列 (前回の実測サイズ入り) は
 * 次に読まれるまで作り直さない。その間に `resizeItem` / `measureElement` で同じ高さを入れると、
 * 古い配列の値と比べて差分 0 と判定され、キャッシュに入らない。結果、高さが変わらなかった行
 * (列数が変わっても高さが同じ展開行) だけ見積もり高さに戻り、ResizeObserver も高さが
 * 変わらないので二度と通知せず、次の行が展開行に重なって描画される。
 * そこで `measure()` の直後に `getTotalSize()` で配列を見積もりで作り直してから入れ直す。
 *
 * `measureElement` ではなく `resizeItem` を直接呼ぶのは、`measureElement` がスクロール中
 * (`isScrolling`) は同期計測を飛ばして ResizeObserver に任せるため。ここで飛ばすと
 * 同じ理由で取り戻せない。
 */
export function remeasureGridRows(
  v: GridRemeasurer,
  rendered: Iterable<{ index: number; size: number }>,
): void {
  v.measure();
  v.getTotalSize();
  for (const { index, size } of rendered) v.resizeItem(index, size);
}

