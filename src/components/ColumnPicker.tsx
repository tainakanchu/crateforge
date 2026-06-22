import { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import { FIELD_DEFS, ALL_FIELDS } from "../types";
import type { FieldKey, CoverSize } from "../types";

interface ColumnPickerProps {
  onClose: () => void;
}

/// ツールバー右上のポップオーバー。表示列のドラッグ並べ替え / トグル、
/// 行高スライダー、アートワークサイズ、Reset を提供。状態は store に即時反映。
///
/// 並べ替えは HTML5 DnD ではなく PointerEvent ベース。webview の draggable は
/// 不安定（ドラッグが始まらない / drop が落ちる）なので、pointer capture で確実化する。
export function ColumnPicker({ onClose }: ColumnPickerProps) {
  const {
    fields,
    toggleField,
    reorderFields,
    rowH,
    setRowH,
    coverSize,
    setCoverSize,
    resetColumns,
  } = useStore();

  const listRef = useRef<HTMLDivElement>(null);
  // ドラッグ中の元インデックス。pointerdown で記録し、move 中に reorder する。
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const available = ALL_FIELDS.filter((id) => !fields.includes(id));

  const onItemPointerDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    dragIdx.current = i;
    setOverIdx(i);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  };
  // pointer Y から表示列リスト内のホバー行を求め、必要なら即座に reorder する。
  const onItemPointerMove = (e: React.PointerEvent) => {
    const from = dragIdx.current;
    if (from === null) return;
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>("[data-field-index]"),
    );
    let target = from;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        target = Number(row.dataset.fieldIndex);
        break;
      }
      // リスト末尾より下なら最後の行を狙う。
      if (e.clientY > r.bottom) target = Number(row.dataset.fieldIndex);
    }
    if (target !== from) {
      reorderFields(from, target);
      dragIdx.current = target;
      setOverIdx(target);
    }
  };
  const onItemPointerUp = () => {
    dragIdx.current = null;
    setOverIdx(null);
    document.body.style.userSelect = "";
  };

  return (
    <>
      <div className="cb-scrim" onClick={onClose} />
      <div className="cb-pop" onClick={(e) => e.stopPropagation()}>
        <div className="cb-pophd">
          <div className="t">Customize columns</div>
          <div className="s">グリップをドラッグで並べ替え・チェックで表示切替</div>
        </div>

        <div className="cb-poplist" ref={listRef}>
          {fields.map((id, i) => (
            <div
              key={id}
              data-field-index={i}
              className={"cb-pi" + (overIdx === i ? " dragover" : "")}
            >
              <span
                className="grip"
                title="ドラッグで並べ替え"
                style={{ cursor: "grab", touchAction: "none" }}
                onPointerDown={(e) => onItemPointerDown(e, i)}
                onPointerMove={onItemPointerMove}
                onPointerUp={onItemPointerUp}
              >
                <Icon name="dragHandle" size={15} />
              </span>
              <span className="lbl">{FIELD_DEFS[id].label}</span>
              <span className="cb-chk on" onClick={() => toggleField(id)}>
                <Icon name="check" size={13} />
              </span>
            </div>
          ))}

          {available.length > 0 && <div className="cb-popavail">Available</div>}
          {available.map((id: FieldKey) => (
            <div key={id} className="cb-pi off" onClick={() => toggleField(id)}>
              <span className="grip">
                <Icon name="plus" size={15} />
              </span>
              <span className="lbl">{FIELD_DEFS[id].label}</span>
              <span className="cb-chk">
                <Icon name="check" size={13} />
              </span>
            </div>
          ))}
        </div>

        <div className="cb-popft">
          <div className="cb-ctrlrow">
            <div className="cb-ctrll">
              <span>Row height</span>
              <span className="cb-ctrlv">{rowH}px</span>
            </div>
            <input
              className="cb-range"
              type="range"
              min={32}
              max={64}
              step={2}
              value={rowH}
              onChange={(e) => setRowH(+e.target.value)}
            />
          </div>
          <div className="cb-ctrlrow">
            <div className="cb-ctrll">
              <span>Artwork</span>
            </div>
            <div className="cb-seg2">
              {([0, 20, 28] as CoverSize[]).map((s) => (
                <button
                  key={s}
                  className={"cb-segb2" + (coverSize === s ? " on" : "")}
                  // アートワーク列幅: Off=非表示 / S=小(20px) / M=中(28px)
                  title={s === 0 ? "Artwork: Off" : s === 20 ? "Artwork: Small" : "Artwork: Medium"}
                  aria-label={s === 0 ? "Artwork: Off" : s === 20 ? "Artwork: Small" : "Artwork: Medium"}
                  onClick={() => setCoverSize(s)}
                >
                  {s === 0 ? "Off" : s === 20 ? "S" : "M"}
                </button>
              ))}
            </div>
          </div>
          <button className="cb-reset" onClick={resetColumns}>
            Reset to defaults
          </button>
        </div>
      </div>
    </>
  );
}
