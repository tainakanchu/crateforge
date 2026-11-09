import type { DuplicateHit, ItemAction } from "../types";
import {
  ACTION_LABELS,
  healthLabel,
  hitTooltip,
  kindHint,
  primaryHit,
  replaceTargetOf,
  type DuplicateDecision,
} from "../lib/duplicates";

/** 取り込み済みバッジ (状態 + 確からしさ)。ツールチップに一致した既存曲を出す。 */
export function DuplicateBadge({ hits }: { hits: DuplicateHit[] }) {
  const h = primaryHit(hits);
  if (!h) return null;
  const hint = kindHint(h);
  return (
    <span className={`dup-badge dup-${h.health}`} title={hitTooltip(hits)}>
      {healthLabel(h)}
      {hint ? <span className="dup-hint">（{hint}）</span> : null}
    </span>
  );
}

/** 取り込む / スキップ / 置き換え の選択。 */
export function DuplicateActionSelect({
  hits,
  value,
  onChange,
  disabled,
  allowReplace = true,
}: {
  hits: DuplicateHit[];
  value: DuplicateDecision;
  onChange: (d: DuplicateDecision) => void;
  disabled?: boolean;
  allowReplace?: boolean;
}) {
  const actions: ItemAction[] = allowReplace ? ["import", "skip", "replace"] : ["import", "skip"];
  return (
    <select
      className="dup-action"
      value={value.action}
      disabled={disabled}
      aria-label="取り込み方法"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const action = e.target.value as ItemAction;
        onChange({
          action,
          replaceTrackId: action === "replace" ? replaceTargetOf(hits) : null,
        });
      }}
    >
      {actions.map((a) => (
        <option key={a} value={a}>
          {ACTION_LABELS[a]}
        </option>
      ))}
    </select>
  );
}

/** 「N 曲はすでにライブラリにあります」の扱い別件数 (確認画面用)。 */
export function countActions(decisions: DuplicateDecision[]): Record<ItemAction, number> {
  const c: Record<ItemAction, number> = { import: 0, skip: 0, replace: 0 };
  for (const d of decisions) c[d.action] += 1;
  return c;
}
