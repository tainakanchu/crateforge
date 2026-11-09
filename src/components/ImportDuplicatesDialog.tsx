import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { DuplicateActionSelect, DuplicateBadge, countActions } from "./DuplicateControls";
import { useImportDuplicates } from "../lib/importFlow";
import { defaultDecision, replaceTargetOf, type DuplicateDecision } from "../lib/duplicates";
import type { ImportPlanItem } from "../types";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * ファイル取り込みで「すでにライブラリにある曲」が見つかったときの確認ダイアログ
 * (iTunes の取り込み済み確認相当)。衝突した曲だけを並べ、曲ごとに
 * 取り込む / スキップ / 置き換え を選ばせる。App に 1 つだけマウントし、
 * 表示は lib/importFlow の useImportDuplicates で制御する。
 */
export function ImportDuplicatesDialog() {
  const pending = useImportDuplicates((s) => s.pending);
  if (!pending) return null;
  return <ImportDuplicatesDialogBody key={pending.items.map((i) => i.path).join("\n")} items={pending.items} resolve={pending.resolve} />;
}

function ImportDuplicatesDialogBody({
  items,
  resolve,
}: {
  items: ImportPlanItem[];
  resolve: (d: Map<string, DuplicateDecision> | null) => void;
}) {
  const [decisions, setDecisions] = useState<Map<string, DuplicateDecision>>(
    () => new Map(items.map((i) => [i.path, defaultDecision(i.hits)])),
  );

  const cancel = useCallback(() => resolve(null), [resolve]);
  const proceed = useCallback(() => resolve(decisions), [resolve, decisions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  const setAll = (action: "skip" | "replace") => {
    setDecisions(
      new Map(
        items.map((i) => [
          i.path,
          action === "replace"
            ? { action, replaceTrackId: replaceTargetOf(i.hits) }
            : { action, replaceTrackId: null },
        ]),
      ),
    );
  };

  const counts = useMemo(() => countActions([...decisions.values()]), [decisions]);

  return (
    <div className="modal-overlay" onClick={cancel}>
      <div className="modal dup-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="download" size={16} /> {items.length} 曲はすでにライブラリにあります
          </h2>
          <button className="modal-close" onClick={cancel}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--tx2)" }}>
            同じ曲がライブラリに見つかりました。曲ごとに扱いを選んでください。置き換えると、
            既存の曲（プレイリスト・レート・再生回数・編集したタグ）はそのままに、ファイルだけを新しいものに差し替えます。
            古いファイルは削除せず「_replaced」フォルダへ移します。
          </div>
          <div className="dup-bulk">
            <button className="rip-link" onClick={() => setAll("skip")}>すべてスキップ</button>
            <button className="rip-link" onClick={() => setAll("replace")}>すべて置き換え</button>
          </div>
          <div className="rip-track-list dup-list">
            {items.map((i) => {
              const d = decisions.get(i.path) ?? defaultDecision(i.hits);
              return (
                <div key={i.path} className="rip-track-row" title={i.path}>
                  <span className="rip-track-title">
                    {i.title ?? baseName(i.path)}
                    {i.artist ? <span className="rip-track-artist"> — {i.artist}</span> : null}
                  </span>
                  <DuplicateBadge hits={i.hits} />
                  <DuplicateActionSelect
                    hits={i.hits}
                    value={d}
                    onChange={(nd) => setDecisions((prev) => new Map(prev).set(i.path, nd))}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: "var(--tx2)" }}>
            取り込む {counts.import} / スキップ {counts.skip} / 置き換え {counts.replace}
            （ほかの曲はそのまま取り込みます）
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="toolbar-btn" onClick={cancel}>
              キャンセル
            </button>
            <button className="toolbar-btn primary" onClick={proceed}>
              続ける
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
