import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { DuplicateActionSelect, DuplicateBadge, countActions } from "./DuplicateControls";
import { planDefaultDecision, useImportDuplicates } from "../lib/importFlow";
import { replaceTargetOf, type DuplicateDecision } from "../lib/duplicates";
import type { ImportPlanItem, ItemAction } from "../types";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** パスのフォルダ部分 (末尾の区切り込み)。ファイル名だけなら空。 */
function dirName(p: string): string {
  const name = baseName(p);
  return p.slice(0, p.length - name.length);
}

/**
 * 登録済みのファイルそのもの (同じパス) か。計画の段階で除かれているはずだが、
 * 念のため一致の中に同じパスがあるものも含めて「取り込む」を選ばせない (D11)。
 */
function isSameFile(i: ImportPlanItem): boolean {
  return i.alreadyImportedSamePath || i.hits.some((h) => h.locationPath === i.path);
}

const SKIP: DuplicateDecision = { action: "skip", replaceTrackId: null };

/** 拡張子から表示用の形式名 (FLAC / MP3 …)。 */
function formatOf(p: string): string {
  const m = /\.([^./\\]+)$/.exec(p);
  return m ? m[1].toUpperCase() : "?";
}

function fmtLength(ms: number | null): string {
  if (!ms || ms <= 0) return "--:--";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
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
    () => new Map(items.map((i) => [i.path, isSameFile(i) ? SKIP : planDefaultDecision(i)])),
  );
  // Esc は誤操作で取り込み全体が消えないよう、キャンセルしてよいか確認を挟む (D6)。
  const [confirmCancel, setConfirmCancel] = useState(false);

  const cancel = useCallback(() => resolve(null), [resolve]);
  const proceed = useCallback(() => {
    // 同じファイルは指示に関係なくスキップ (バックエンドも二重登録を拒否する)。
    const out = new Map(decisions);
    for (const i of items) if (isSameFile(i)) out.set(i.path, SKIP);
    resolve(out);
  }, [resolve, decisions, items]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // 1 回目は確認を出すだけ。確認中の Esc は確認を閉じて選択に戻る。
        setConfirmCancel((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 一括指定。「すべて取り込む」でも破損の疑いがあるファイルは明示的に選ばない限り
  // 取り込まない (スキップのまま)。置き換えは一致がある曲だけ (無い曲は取り込む)。
  // 登録済みの同じファイルはどの一括指定でもスキップのまま (D11)。
  const setAll = (action: ItemAction) => {
    setDecisions(
      new Map(
        items.map((i): [string, DuplicateDecision] => {
          if (action === "skip" || isSameFile(i)) return [i.path, SKIP];
          if (i.sourceBroken) return [i.path, SKIP];
          if (action === "replace" && i.hits.length > 0) {
            return [i.path, { action, replaceTrackId: replaceTargetOf(i.hits) }];
          }
          return [i.path, { action: "import", replaceTrackId: null }];
        }),
      ),
    );
  };

  const counts = useMemo(() => countActions([...decisions.values()]), [decisions]);
  const brokenCount = items.filter((i) => i.sourceBroken).length;
  const dupCount = items.length - brokenCount;
  const heading =
    brokenCount === 0
      ? `${items.length} 曲はすでにライブラリにあります`
      : dupCount === 0
        ? `${brokenCount} 曲は破損の疑いがあります`
        : `${items.length} 曲の確認が必要です`;

  return (
    // 背景クリックでは閉じない (取り込み全体のキャンセルになるため。閉じるのは明示操作のみ)。
    <div className="modal-overlay">
      <div className="modal dup-dialog" role="dialog" aria-modal="true" aria-label={heading}>
        <div className="modal-header">
          <h2>
            <Icon name="download" size={16} /> {heading}
          </h2>
          <button className="modal-close" onClick={cancel} title="取り込みをキャンセル">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--tx2)" }}>
            {dupCount > 0 && (
              <>
                同じ曲がライブラリに見つかりました。曲ごとに扱いを選んでください。置き換えると、
                既存の曲（プレイリスト・レート・再生回数・編集したタグ）はそのままに、ファイルだけを新しいものに差し替えます。
                古いファイルは削除せず「_replaced」フォルダへ移します。
              </>
            )}
            {brokenCount > 0 && (
              <>
                {dupCount > 0 ? " " : ""}
                「破損の疑い」のファイルは末尾がゼロで埋まっている (同期の失敗など) 可能性があるため、既定ではスキップします。
              </>
            )}
          </div>
          <div className="dup-bulk">
            <button className="rip-link" onClick={() => setAll("import")}>すべて取り込む</button>
            <button className="rip-link" onClick={() => setAll("skip")}>すべてスキップ</button>
            {dupCount > 0 && (
              <button className="rip-link" onClick={() => setAll("replace")}>すべて置き換え</button>
            )}
          </div>
          <div className="rip-track-list dup-list">
            {items.map((i) => {
              const sameFile = isSameFile(i);
              const d = sameFile ? SKIP : (decisions.get(i.path) ?? planDefaultDecision(i));
              return (
                <div key={i.path} className="rip-track-row dup-row" title={i.path}>
                  <div className="dup-row-main">
                    <span className="rip-track-title">
                      {i.title ?? baseName(i.path)}
                      {i.artist ? <span className="rip-track-artist"> — {i.artist}</span> : null}
                    </span>
                    <span className="dup-row-meta">
                      <span className="dup-row-fmt">{formatOf(i.path)}</span>
                      <span className="rip-track-len">{fmtLength(i.durationMs)}</span>
                      {/* 長いパスは先頭側を省略し、ファイル名は必ず見せる (D6)。 */}
                      <span className="dup-row-path">
                        <span className="dup-row-dir">{"\u200e" + dirName(i.path) + "\u200e"}</span>
                        <span className="dup-row-file">{baseName(i.path)}</span>
                      </span>
                    </span>
                  </div>
                  {i.sourceBroken && (
                    <span
                      className="dup-badge dup-broken"
                      title="取り込むファイルの末尾がゼロで埋まっています (同期の失敗などで壊れている可能性)"
                    >
                      破損の疑い
                    </span>
                  )}
                  {sameFile ? (
                    <span
                      className="dup-badge"
                      title="このファイル自体がすでにライブラリに登録されています (取り込むと二重登録になるためスキップします)"
                    >
                      登録済み（同じファイル）
                    </span>
                  ) : (
                    <DuplicateBadge hits={i.hits} />
                  )}
                  <DuplicateActionSelect
                    hits={i.hits}
                    value={d}
                    disabled={sameFile}
                    allowReplace={!sameFile && i.hits.length > 0}
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
          {confirmCancel ? (
            <div className="dup-cancel-confirm" role="alertdialog" aria-label="取り込みのキャンセル確認">
              <span>取り込みをキャンセルしますか？（どのファイルも取り込みません）</span>
              <button className="toolbar-btn" autoFocus onClick={() => setConfirmCancel(false)}>
                選択に戻る
              </button>
              <button className="toolbar-btn danger" onClick={cancel}>
                キャンセルする
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="toolbar-btn" onClick={cancel}>
                取り込みをキャンセル
              </button>
              <button className="toolbar-btn primary" onClick={proceed}>
                続ける
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
