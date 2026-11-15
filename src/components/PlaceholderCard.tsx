interface PlaceholderCardProps {
  /** カードの一辺 (実データのカードと同じ値)。 */
  size: number;
  /** カード下のラベルの行数 (実データのカードと同じ数。ソートキーの補助行があれば 3)。 */
  lines?: 2 | 3;
}

/**
 * まだ取得していない項目のカード (docs/library-list/design.md §1)。
 *
 * カードグリッドの行は実測した高さで並ぶので、実データのカードと同じ構造 (カード + ラベル行) に
 * して高さをそろえる。データが届いても行の高さが変わらず、後ろの行がずれない。
 */
export function PlaceholderCard({ size, lines = 2 }: PlaceholderCardProps) {
  return (
    <div className="cb-cardwrap ph" aria-hidden>
      <div className="cb-card" style={{ height: size }} />
      <div className="cov-meta">
        <div className="cj">{" "}</div>
        <div className="la">{" "}</div>
        {lines === 3 && <div className="ls">{" "}</div>}
      </div>
    </div>
  );
}
