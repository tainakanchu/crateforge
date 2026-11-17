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

export type GridCardRow<T> = { type: "grid"; key: string; items: T[] };
export type GridExpandRow<T> = { type: "expand"; key: string; item: T };
export type GridRow<T> = GridCardRow<T> | GridExpandRow<T>;

/**
 * items を cols 枚ずつのグリッド行に分け、expandedKey の項目を含む行の直後に展開行を差し込む。
 *
 * 行キーは仮想化の実測サイズのキャッシュキーになるので、展開の開閉で変わってはいけない
 * (行番号をキーにすると、展開行の挿入/除去で後続行の番号がずれ、実測サイズが別の行に
 * 付け替わって行が重なる)。
 * - グリッド行: `g:<cols>:<グリッド行の通し番号>` (展開行を数えない番号。同じ曲が複数回入る
 *   プレイリストでも一意)
 * - 展開行: `x:<項目キー>`
 *
 * 展開しないグリッド (TracksView) は keyOf / expandedKey を省略でき、グリッド行だけが返る。
 */
export function buildGridRows<T>(items: readonly T[], cols: number): GridCardRow<T>[];
export function buildGridRows<T>(
  items: readonly T[],
  cols: number,
  keyOf: (item: T) => string,
  expandedKey: string | null,
): GridRow<T>[];
export function buildGridRows<T>(
  items: readonly T[],
  cols: number,
  keyOf?: (item: T) => string,
  expandedKey: string | null = null,
): GridRow<T>[] {
  const n = Math.max(1, Math.floor(cols));
  const out: GridRow<T>[] = [];
  for (let i = 0; i < items.length; i += n) {
    const chunk = items.slice(i, i + n);
    out.push({ type: "grid", key: `g:${n}:${i / n}`, items: chunk });
    if (!keyOf || expandedKey === null) continue;
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

/** 行の高さを左右する寸法。これが変わったときだけ実測キャッシュを捨てる。 */
export interface GridMeasureKey {
  /** グリッド行 1 行の高さの見積もり (カード幅・ラベル行数で決まる)。 */
  gridRowHeight: number;
  cols: number;
}

/**
 * 仮想化の実測キャッシュを捨てて測り直すべきか。
 *
 * 引数に行リストや展開状態を取らないのは意図どおり: 展開の開閉・遅延取得・追加ロードで
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

/**
 * 追加ロードしたページを末尾に足す。既にあるキーの行は足さない。
 *
 * offset ページングは、取得の合間に並びが変わると同じ行が 2 ページにまたがって返りうる。
 * 項目キーは展開行の行キー (`x:<項目キー>`) になるので、重複させない。
 */
export function appendUniqueBy<T>(
  prev: readonly T[],
  page: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set(prev.map(keyOf));
  const out = [...prev];
  for (const it of page) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
